// @effect-diagnostics asyncFunction:off -- a Durable Object's RPC methods and alarm handler are Promise APIs.
import { webCrypto } from "@mischief/plan-run";
import { Identity } from "@rat-king/mailbox-client";
import { DurableObject } from "cloudflare:workers";
import { Clock, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import { FetchHttpClient } from "effect/http";

import { openMailroom } from "./mailroom.js";
import type { Env } from "./plan-run-object.js";
import { PostboxFailed } from "./postbox-failed.js";
import { leaseBook } from "./postbox-lease.js";
import { postbox } from "./postbox.js";
import { Delivered, Runs } from "./runs-port.js";
import type { DeliveredValue, ReplyLine } from "./runs-port.js";
import { dayTotals, dayWarning, tally } from "./think-tally.js";

export const POSTBOX_NAME = "mischief/worker";

const WATCHDOG_MS = 60_000;

export type Posted<A> =
  | ({ readonly ok: true } & A)
  | { readonly ok: false; readonly reason: string };

const NOT_WIRED =
  "Rat King mail is not wired on this host: set MISCHIEF_IDENTITY (the mischief/worker identity, from the host's 0600 bindings file), MISCHIEF_MAILBOX_URL and MISCHIEF_MAILBOX_DID, then redeploy";

const Refusal = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.Literal("ReplyRefused"),
    reason: Schema.String,
  })
);

type OpenMailroom = Effect.Success<ReturnType<typeof openMailroom>>;

const posted = async <A extends object>(
  effect: Effect.Effect<A, PostboxFailed>
): Promise<Posted<A>> => {
  const exit = await Effect.runPromiseExit(effect);

  return Exit.match(exit, {
    onFailure: () => ({
      ok: false as const,
      reason: Option.match(Exit.findErrorOption(exit), {
        onNone: () => "the Postbox failed unexpectedly; see the celld journal",
        onSome: ({ reason }) => reason,
      }),
    }),
    onSuccess: (value) => ({ ok: true as const, ...value }),
  });
};

const now = () => Effect.runSync(Clock.currentTimeMillis);

export class Postbox extends DurableObject<Env> {
  private readonly box;
  private readonly scope = Effect.runSync(Scope.make());
  private mailroom: OpenMailroom | undefined;
  private consuming = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.box = postbox(ctx.storage);
  }

  private wired(): Effect.Effect<OpenMailroom, PostboxFailed> {
    const identity = Schema.decodeUnknownOption(
      Schema.fromJsonString(Identity)
    )(this.env.MISCHIEF_IDENTITY ?? "");

    const endpoint = this.env.MISCHIEF_MAILBOX_URL ?? "";
    const serviceDid = this.env.MISCHIEF_MAILBOX_DID ?? "";

    if (this.mailroom !== undefined) {
      return Effect.succeed(this.mailroom);
    }

    if (Option.isNone(identity) || endpoint === "" || serviceDid === "") {
      return Effect.fail(new PostboxFailed({ reason: NOT_WIRED }));
    }

    return openMailroom({
      endpoint,
      identity: identity.value,
      leases: leaseBook(this.ctx.storage),
      serviceDid,
    }).pipe(
      Scope.provide(this.scope),
      Effect.provide(Layer.merge(FetchHttpClient.layer, webCrypto)),
      Effect.tap((opened) =>
        Effect.sync(() => {
          this.mailroom = opened;
        })
      )
    );
  }

  private readonly runs = Layer.succeed(
    Runs,
    Runs.of({
      deliver: (objectName: string, line: ReplyLine) =>
        Effect.tryPromise({
          catch: () =>
            new PostboxFailed({ reason: `run ${objectName} did not answer` }),
          try: async () => {
            const run = this.env.PLAN_RUN.get(
              this.env.PLAN_RUN.idFromName(objectName)
            );

            const response = await run.fetch(
              new Request("https://mischief.internal/deliverReply", {
                body: JSON.stringify(line),
                headers: { "content-type": "application/json" },
                method: "POST",
              })
            );

            return { body: await response.text(), status: response.status };
          },
        }).pipe(
          Effect.flatMap(
            ({
              body,
              status,
            }): Effect.Effect<DeliveredValue, PostboxFailed> => {
              if (status === 200) {
                return Effect.succeed(Delivered.cases.Journaled.make({}));
              }

              return Option.match(Schema.decodeUnknownOption(Refusal)(body), {
                onNone: () =>
                  Effect.fail(
                    new PostboxFailed({
                      reason: `run ${objectName} answered HTTP ${status}`,
                    })
                  ),
                onSome: ({ reason }) =>
                  Effect.succeed(Delivered.cases.Refused.make({ reason })),
              });
            }
          )
        ),
    })
  );

  async seal(objectName: string, to: string, body: string) {
    await this.start();

    return await posted(
      this.wired().pipe(
        Effect.flatMap(({ layer }) =>
          this.box.seal(objectName, to, body).pipe(Effect.provide(layer))
        )
      )
    );
  }

  async send(envelope: string) {
    return await posted(
      this.wired().pipe(
        Effect.flatMap(({ layer }) =>
          this.box.send(envelope).pipe(Effect.provide(layer), Effect.as({}))
        )
      )
    );
  }

  // oxlint-disable-next-line require-await -- a Durable Object RPC method returns a Promise; the tally is synchronous SQLite.
  async tallyThink(day: string, runId: string, tokens: number) {
    return tally(this.ctx.storage, day, runId, tokens);
  }

  // oxlint-disable-next-line require-await -- a Durable Object RPC method returns a Promise; the read is synchronous SQLite.
  async thinkDay(day: string) {
    return {
      ...dayTotals(this.ctx.storage, day),
      warning: dayWarning(this.ctx.storage, day),
    };
  }

  async start() {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now());
    }
  }

  override async alarm() {
    await this.ctx.storage.setAlarm(now() + WATCHDOG_MS);

    if (this.consuming) {
      return;
    }

    const wired = await Effect.runPromiseExit(this.wired());

    if (Exit.isFailure(wired)) {
      return;
    }

    this.consuming = true;

    const { consume, layer } = wired.value;

    this.ctx.waitUntil(
      Effect.runPromise(
        consume(
          (message, seq) =>
            this.box
              .receive(message, seq)
              .pipe(Effect.provide(Layer.merge(layer, this.runs))),
          this.box.cursor()
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "the Postbox reader stopped; the watchdog restarts it",
              cause
            )
          ),
          Effect.ensuring(
            Effect.sync(() => {
              this.consuming = false;
            })
          )
        )
      )
    );
  }
}
