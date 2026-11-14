// @effect-diagnostics asyncFunction:off -- Durable Object RPC, alarm and storage methods are Promise APIs.
import type { PeonIndexEntry, PeonReport, PeonTemplate } from "@mischief/core";
import { PeonRefused } from "@mischief/core";
import { DurableObject } from "cloudflare:workers";
import { Effect, Option, Schema, Semaphore } from "effect";

import { peonBox } from "./peon-box.js";
import { peonHost } from "./peon-host.js";
import { PEON_REGISTRY, PeonCompleted, PeonStored } from "./peon-state.js";
import type { PeonPending } from "./peon-state.js";
import type { Env } from "./plan-run-object.js";

export const peonRpc = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (error) =>
      new PeonRefused({
        reason: `Peon object call failed: ${String(error)}. Use inspectPeon before retrying; pending box operations keep their original requestId.`,
      }),
    try: operation,
  });

const events = {
  clone: "CLONE",
  destroy: "DESTROY",
  hibernate: "HIBERNATE",
  prompt: "PROMPT",
  resume: "RESUME",
  spawn: "SPAWN",
  suspend: "SUSPEND",
} as const;

export class Peon extends DurableObject<Env> {
  private readonly host;
  private readonly lock = Semaphore.makeUnsafe(1);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const registry = () => env.PEON_TEMPLATES.getByName(PEON_REGISTRY);
    this.host = peonHost({
      box: peonBox(
        env.MISCHIEF_BOX_URL ?? "http://192.0.2.1",
        env.MISCHIEF_BOX_KEY ?? ""
      ),
      clone: (id, source, requestId) =>
        Effect.gen(function* initializeClone() {
          const entry: typeof PeonIndexEntry.Type = {
            creationKey: `clone/${source.peonId}/${requestId}`,
            owner: source.owner,
            peonId: id,
            state: "suspended",
            template: source.template,
            updatedAt: source.updatedAt,
          };

          return yield* peonRpc(
            async () =>
              await env.PEON.getByName(id).initialize(
                entry,
                source.resolvedTemplate,
                true
              )
          );
        }),
      guardMs: Number(env.MISCHIEF_GUARD_MS),
      publish: (entry) =>
        peonRpc(async () => {
          await registry().update(entry);
        }),
      reply: (to, messageId, peonId, text) =>
        peonRpc(async () => {
          await env.POSTBOX.getByName("mischief/worker").replyPeon(
            to,
            messageId,
            peonId,
            text
          );
        }),
      reserveClone: (id, source, requestId) =>
        peonRpc(async () => {
          await registry().claim({
            creationKey: `clone/${source.peonId}/${requestId}`,
            owner: source.owner,
            peonId: id,
            state: "spawned",
            template: source.template,
            updatedAt: source.updatedAt,
          });
        }),
      storage: {
        commit: (stored, alarm, completed) =>
          Effect.promise(async () => {
            if (
              stored.pending === null &&
              stored.report.state === "destroyed"
            ) {
              await ctx.storage.deleteAll();
              await ctx.storage.deleteAlarm();

              return;
            }

            await ctx.storage.transaction(async (transaction) => {
              await transaction.put(
                "peon",
                Schema.decodeUnknownSync(PeonStored)(stored)
              );

              if (completed !== undefined) {
                await transaction.put(
                  `request:${completed.requestId}`,
                  completed.value
                );

                if (completed.log !== undefined) {
                  await transaction.put(
                    `prompt:${completed.requestId}`,
                    completed.log
                  );
                }
              }

              await (alarm === null
                ? transaction.deleteAlarm()
                : transaction.setAlarm(alarm));
            });
          }),
        completed: (requestId) =>
          Effect.promise(
            async () => await ctx.storage.get(`request:${requestId}`)
          ).pipe(
            Effect.map((value) =>
              value === undefined
                ? undefined
                : Schema.decodeUnknownSync(PeonCompleted)(value)
            )
          ),
        load: Effect.promise(async () => await ctx.storage.get("peon")).pipe(
          Effect.map((value) =>
            value === undefined
              ? undefined
              : Schema.decodeUnknownSync(PeonStored)(value)
          )
        ),
      },
    });
  }

  private async run<A>(effect: Effect.Effect<A, PeonRefused>) {
    if (
      this.env.MISCHIEF_PEON_BOXES !== "on" ||
      this.env.MISCHIEF_BOX_URL === undefined ||
      this.env.MISCHIEF_BOX_KEY === undefined
    ) {
      throw new PeonRefused({
        reason:
          "Peon boxes are off or unwired; starting one would bypass host authorization. Ask the desk to set MISCHIEF_PEON_BOXES=on, MISCHIEF_BOX_URL and MISCHIEF_BOX_KEY, then retry spawnPeon.",
      });
    }

    return await Effect.runPromise(
      this.lock
        .withPermitsIfAvailable(1)(effect)
        .pipe(
          Effect.flatMap((value) =>
            Option.isSome(value)
              ? Effect.succeed(value.value)
              : Effect.fail(
                  new PeonRefused({
                    reason:
                      "This peon is already handling a call; a concurrent turn would race its workspace. Use inspectPeon and retry the same requestId when it finishes.",
                  })
                )
          )
        )
    );
  }

  async initialize(
    entry: typeof PeonIndexEntry.Type,
    template: typeof PeonTemplate.Type,
    cloned = false
  ) {
    return await this.run(this.host.initialize(entry, template, cloned));
  }

  async command(
    kind: (typeof PeonPending.Type)["kind"],
    requestId: string,
    text?: string,
    newPeonId?: string,
    sender?: string
  ) {
    return await this.run(
      this.host.command(kind, requestId, events[kind], {
        newPeonId,
        sender,
        text,
      })
    );
  }

  async acceptMail(requestId: string, text: string, sender: string) {
    const report = await this.run(
      this.host.command("prompt", requestId, "PROMPT", {
        defer: true,
        mail: true,
        sender,
        text,
      })
    );

    this.ctx.waitUntil(this.run(this.host.idle()));

    return report;
  }

  async inspect(): Promise<typeof PeonReport.Type> {
    return await Effect.runPromise(
      this.env.MISCHIEF_PEON_BOXES === "on"
        ? this.host.inspect
        : this.host.inspectStored
    );
  }

  override async alarm() {
    if ((await this.ctx.storage.get("peon")) === undefined) {
      await this.ctx.storage.deleteAlarm();

      return;
    }

    await this.run(this.host.idle());
  }
}
