// @effect-diagnostics asyncFunction:off -- a Durable Object's RPC methods and alarm handler are Promise APIs.
import { webCrypto } from "@mischief/plan-run";
import { Identity } from "@rat-king/mailbox-client";
import { DurableObject } from "cloudflare:workers";
import { Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import { FetchHttpClient } from "effect/http";

import { decodeDelivery } from "./decode-delivery.js";
import { openMailroom } from "./mailroom.js";
import type { Env } from "./plan-run-object.js";
import { PostboxFailed } from "./postbox-failed.js";
import { readBatch } from "./postbox-inbox.js";
import { leaseBook } from "./postbox-lease.js";
import { PostboxReaderFailed } from "./postbox-reader-failed.js";
import { readerHost } from "./postbox-reader-host.js";
import { PostboxReader } from "./postbox-reader.js";
import type { OpenMailroom } from "./postbox-reader.js";
import { postbox } from "./postbox.js";
import { Runs } from "./runs-port.js";
import type { ReplyLine } from "./runs-port.js";
import { dayTotals, dayWarning, tally } from "./think-tally.js";

export const POSTBOX_NAME = "mischief/worker";

export type Posted<A> =
  | ({ readonly ok: true } & A)
  | { readonly ok: false; readonly reason: string };

const NOT_WIRED =
  "Rat King mail is not wired on this host: set MISCHIEF_IDENTITY (the mischief/worker identity, from the host's 0600 bindings file), MISCHIEF_MAILBOX_URL and MISCHIEF_MAILBOX_DID, then redeploy";

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

export class Postbox extends DurableObject<Env> {
  private readonly box;
  private readonly leases;
  private readonly host;
  private readonly mailWired;
  private readonly scope = Effect.runSync(Scope.make());
  private opened: OpenMailroom | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.box = postbox(ctx.storage);
    this.leases = leaseBook(ctx.storage);
    this.mailWired =
      env.MISCHIEF_IDENTITY !== undefined && env.MISCHIEF_IDENTITY !== "";
    this.host = readerHost(
      {
        get: Effect.promise(async () => await ctx.storage.getAlarm()).pipe(
          Effect.map(Option.fromNullishOr)
        ),
        set: (at) =>
          Effect.promise(async () => {
            await ctx.storage.setAlarm(at);
          }),
      },
      (turn) => this.readerIn(turn)
    );
    void ctx.blockConcurrencyWhile(async () => {
      await this.start();
    });
  }

  private sender(): Effect.Effect<OpenMailroom, PostboxFailed> {
    return Effect.suspend(() =>
      this.opened === undefined
        ? this.open().pipe(
            Scope.provide(this.scope),
            Effect.tap((opened) =>
              Effect.sync(() => {
                this.opened = opened;
              })
            )
          )
        : Effect.succeed(this.opened)
    );
  }

  private readerIn(scope: Scope.Scope) {
    return PostboxReader.of({
      read: ({ inbox, layer }) =>
        Effect.suspend(() =>
          readBatch(inbox, {
            advance: (seq) => {
              this.box.advance(seq);
            },
            cursor: () => this.box.cursor(),
            leases: this.leases,
            receive: (message) =>
              this.box
                .receive(message)
                .pipe(Effect.provide(Layer.merge(layer, this.runs))),
          })
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(PostboxReaderFailed.fromCause(cause))
          )
        ),
      wire: Effect.suspend(() => this.open()).pipe(
        Scope.provide(scope),
        Effect.catchCause((cause) =>
          Effect.fail(PostboxReaderFailed.fromCause(cause))
        )
      ),
    });
  }

  private open(): Effect.Effect<OpenMailroom, PostboxFailed, Scope.Scope> {
    const identity = Schema.decodeUnknownOption(
      Schema.fromJsonString(Identity)
    )(this.env.MISCHIEF_IDENTITY ?? "");

    const endpoint = this.env.MISCHIEF_MAILBOX_URL ?? "";
    const serviceDid = this.env.MISCHIEF_MAILBOX_DID ?? "";

    if (Option.isNone(identity) || endpoint === "" || serviceDid === "") {
      return Effect.fail(new PostboxFailed({ reason: NOT_WIRED }));
    }

    return openMailroom({
      endpoint,
      identity: identity.value,
      leases: this.leases,
      serviceDid,
    }).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, webCrypto)));
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
          Effect.flatMap(({ body, status }) =>
            decodeDelivery(objectName, status, body)
          )
        ),
    })
  );

  async seal(objectName: string, to: string, body: string) {
    await this.start();

    return await posted(
      this.sender().pipe(
        Effect.flatMap(({ layer }) =>
          this.box.seal(objectName, to, body).pipe(Effect.provide(layer))
        )
      )
    );
  }

  async aborted(objectName: string, reason: string) {
    this.box.markAborted(objectName, reason);
    await this.start();

    this.ctx.waitUntil(
      Effect.runPromise(
        this.sender().pipe(
          Effect.flatMap(({ layer }) =>
            this.box.flushAbortNotices.pipe(Effect.provide(layer))
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("abort reply notices remain pending", cause)
          )
        )
      )
    );

    return { ok: true as const };
  }

  async send(envelope: string) {
    return await posted(
      this.sender().pipe(
        Effect.flatMap(({ layer }) =>
          this.box.send(envelope).pipe(Effect.provide(layer), Effect.as({}))
        )
      )
    );
  }

  // oxlint-disable-next-line require-await -- a Durable Object RPC method returns a Promise; the tally is synchronous SQLite.
  async tallyThink(day: string, runId: string, key: string, tokens: number) {
    return tally(this.ctx.storage, day, runId, key, tokens);
  }

  // oxlint-disable-next-line require-await -- a Durable Object RPC method returns a Promise; the read is synchronous SQLite.
  async thinkDay(day: string) {
    return {
      ...dayTotals(this.ctx.storage, day),
      warning: dayWarning(this.ctx.storage, day),
    };
  }

  async start() {
    if (this.mailWired) {
      await Effect.runPromise(this.host.start);
    }
  }

  override async alarm() {
    if (!this.mailWired) {
      return;
    }

    this.ctx.waitUntil(
      Effect.runPromise(
        this.sender().pipe(
          Effect.flatMap(({ layer }) =>
            this.box.flushAbortNotices.pipe(Effect.provide(layer))
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("abort reply notices remain pending", cause)
          )
        )
      )
    );

    await Effect.runPromise(this.host.alarm);
  }
}
