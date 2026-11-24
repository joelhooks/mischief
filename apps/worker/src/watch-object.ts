// @effect-diagnostics asyncFunction:off -- Durable Object RPC, alarms and storage transactions use Promise APIs.
import { WatchDefinition, WatchRefused } from "@mischief/core";
import { DurableObject } from "cloudflare:workers";
import { DateTime, Effect, Result, Schema, Semaphore } from "effect";

import type { Sealed } from "./mailroom-port.js";
import { PEON_REGISTRY } from "./peon-state.js";
import type { Env } from "./plan-run-object.js";
import { PostboxFailed } from "./postbox-failed.js";
import { POSTBOX_NAME } from "./postbox-object.js";
import type { Posted } from "./postbox-object.js";
import { reserveWatchWake } from "./watch-budget.js";
import { checkHttp, checkPeon, watchRefusal } from "./watch-check.js";
import { watchEngine } from "./watch-engine.js";
import { WatchCheckpoint } from "./watch-machine.js";

export const WATCH_DIRECTORY = "watch-directory";

export const watchBudgetName = (name: string) => `budget/${name}`;

const RECORD = "watch";

const wakeKeys = Schema.decodeUnknownSync(Schema.Array(Schema.String));

const readRecorded = Schema.decodeUnknownSync(WatchCheckpoint);

const writeRecorded = Schema.encodeSync(WatchCheckpoint);

const readRefusal = Schema.encodeSync(WatchRefused);

const reply = async <A>(effect: Effect.Effect<A, WatchRefused>) =>
  await Effect.runPromise(
    effect.pipe(
      Effect.result,
      Effect.map((result) =>
        Result.isSuccess(result)
          ? { value: result.success }
          : { refusal: readRefusal(result.failure) }
      )
    )
  );

const postboxCall = <A extends object>(call: () => Promise<Posted<A>>) =>
  Effect.tryPromise({
    try: call,
    catch: () =>
      new PostboxFailed({
        reason:
          "The Postbox did not answer. The watch retains its delivery for the next alarm.",
      }),
  }).pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result)
        : Effect.fail(new PostboxFailed({ reason: result.reason }))
    )
  );

export class WatchObject extends DurableObject<Env> {
  private readonly lock = Semaphore.makeUnsafe(1);
  private readonly storage = this.ctx.storage;
  private readonly engine = watchEngine({
    load: Effect.promise(async () => {
      const raw = await this.storage.get(RECORD);

      return raw === undefined ? undefined : readRecorded(raw);
    }),
    save: (checkpoint) =>
      Effect.promise(async () => {
        await this.storage.transaction(async (transaction) => {
          await transaction.put(RECORD, writeRecorded(checkpoint));

          if (checkpoint.pending !== null) {
            await transaction.put(
              `cursor:${checkpoint.pending.firing.cursor}`,
              true
            );
          }

          await (checkpoint.nextAt === null
            ? transaction.deleteAlarm()
            : transaction.setAlarm(checkpoint.nextAt));
        });
      }),
    seen: (cursor) =>
      Effect.promise(
        async () => (await this.storage.get(`cursor:${cursor}`)) !== undefined
      ),
    check: (watch) => {
      const { condition, owner } = watch;

      if (condition.type === "http") {
        return checkHttp(condition, this.env.MISCHIEF_WATCH_HTTP_HOSTS, fetch);
      }

      return Effect.tryPromise({
        catch: () => null,
        try: async () => {
          const entry = await this.env.PEON_TEMPLATES.getByName(
            PEON_REGISTRY
          ).lookup(condition.peonId);

          if (entry === null || entry.owner !== owner) {
            return null;
          }

          if (entry.state === "destroyed") {
            return { lastTurnId: null, pending: false, state: entry.state };
          }

          return await this.env.PEON.getByName(condition.peonId).watchContext(
            owner
          );
        },
      }).pipe(
        Effect.orElseSucceed(() => null),
        Effect.flatMap((observation) => checkPeon(condition, observation))
      );
    },
    reserve: (name, at, key) =>
      Effect.promise(async () => {
        const binding = this.env.WATCH;

        if (binding === undefined) {
          throw new Error("Bind WATCH before retrying this alarm.");
        }

        const day = DateTime.formatIsoDateUtc(DateTime.makeUnsafe(at));

        return await binding
          .getByName(watchBudgetName(name))
          .reserveWake(day, key);
      }),
    seal: (mail) =>
      postboxCall<Sealed>(
        async () =>
          await this.env.POSTBOX.getByName(POSTBOX_NAME).sealWatch(mail)
      ).pipe(Effect.map(({ envelope }) => envelope)),
    send: (delivery, envelope, deadline) =>
      postboxCall<{ verdict: "accepted" | "refused" | "uncertain" }>(
        async () =>
          await this.env.POSTBOX.getByName(POSTBOX_NAME).sendWatch(
            delivery.name,
            envelope,
            delivery.wake,
            deadline
          )
      ).pipe(Effect.map(({ verdict }) => verdict)),
  });

  async arm(
    watchId: string,
    owner: string,
    definition: typeof WatchDefinition.Type
  ) {
    return await reply(
      this.lock.withPermit(
        this.engine.arm(
          watchId,
          owner,
          Schema.decodeSync(WatchDefinition)(definition)
        )
      )
    );
  }

  async inspect(owner: string) {
    return await reply(this.engine.inspect(owner));
  }

  async stop(owner: string, state: "done" | "cancelled") {
    return await reply(this.lock.withPermit(this.engine.stop(owner, state)));
  }

  async summary() {
    return await Effect.runPromise(this.engine.summary);
  }

  async register(watchId: string) {
    await this.storage.put(`id:${watchId}`, true);
  }

  async page(after: string | undefined) {
    const options: DurableObjectListOptions = { prefix: "id:", limit: 64 };

    if (after !== undefined) {
      options.startAfter = after;
    }

    const page = await this.storage.list(options);

    return [...page.keys()];
  }

  async reserveWake(day: string, key: string) {
    return await this.storage.transaction(async (transaction) => {
      const dayKey = `day:${day}`;
      const stored = await transaction.get(dayKey);

      const budget = reserveWatchWake(
        stored === undefined ? [] : wakeKeys(stored),
        key
      );

      if (budget.allowed) {
        await transaction.put(dayKey, budget.used);
      }

      return budget.allowed;
    });
  }

  override async alarm() {
    await Effect.runPromise(this.lock.withPermit(this.engine.alarm));
  }
}

export const watchUnavailable = () =>
  watchRefusal(
    "NotGranted",
    "Durable watches are not configured on this host. Ask the desk to bind WATCH and retry the watch call."
  );
