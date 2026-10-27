// @effect-diagnostics asyncFunction:off -- the fixture supplies Durable Object RPC methods and forwards a reply over fetch.
import { DurableObject } from "cloudflare:workers";
import { Effect, Exit, Layer, Option, Schema } from "effect";

import { decodeDelivery } from "../../src/decode-delivery.js";
import { Mailroom, SendVerdict } from "../../src/mailroom-port.js";
import type { Env } from "../../src/plan-run-object.js";
import { postbox } from "../../src/postbox.js";
import { Runs } from "../../src/runs-port.js";

const Reply = Schema.Struct({ ask: Schema.String, objectName: Schema.String });

export class Postbox extends DurableObject<Env> {
  private readonly box;
  private readonly layer;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.box = postbox(ctx.storage);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sent (envelope TEXT PRIMARY KEY)"
    );
    this.layer = Layer.succeed(
      Mailroom,
      Mailroom.of({
        nameOf: () => Effect.succeedSome("sender/desk"),
        seal: (to, body) =>
          Effect.succeed({
            envelope: JSON.stringify({ body, to }),
            messageId: body,
          }),
        send: (envelope) =>
          Effect.sync(() => {
            ctx.storage.sql.exec(
              "INSERT INTO sent (envelope) VALUES (?) ON CONFLICT DO NOTHING",
              envelope
            );

            return SendVerdict.cases.Accepted.make({});
          }),
        surface: () => Effect.void,
        tell: () => Effect.void,
      })
    );
  }

  async seal(objectName: string, to: string, body: string) {
    const sealed = await Effect.runPromise(
      this.box.seal(objectName, to, body).pipe(Effect.provide(this.layer))
    );

    return { ...sealed, ok: true as const };
  }

  async send(envelope: string) {
    await Effect.runPromise(
      this.box.send(envelope).pipe(Effect.provide(this.layer))
    );

    return { ok: true as const };
  }

  async aborted(objectName: string, reason: string) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS abort_attempts (run_id TEXT PRIMARY KEY)"
    );

    const first =
      this.ctx.storage.sql
        .exec(
          "INSERT INTO abort_attempts (run_id) VALUES (?) ON CONFLICT DO NOTHING RETURNING run_id",
          objectName
        )
        .toArray().length > 0;

    if (first) {
      return {
        ok: false as const,
        reason: "the first Postbox registration was unavailable",
      };
    }

    await Effect.runPromise(
      this.box.abort(objectName, reason).pipe(Effect.provide(this.layer))
    );

    return { ok: true as const };
  }

  override async fetch(request: Request) {
    if (new URL(request.url).pathname === "/test/notices") {
      return Response.json(
        this.ctx.storage.sql.exec("SELECT envelope FROM sent").toArray()
      );
    }

    const { ask, objectName } = Schema.decodeUnknownSync(Reply)(
      await request.json()
    );

    const runs = Layer.succeed(
      Runs,
      Runs.of({
        deliver: (_name, line) =>
          Effect.promise(async () => {
            const response = await this.env.PLAN_RUN.get(
              this.env.PLAN_RUN.idFromName(objectName)
            ).fetch(
              new Request("https://test/deliverReply", {
                body: JSON.stringify(line),
                headers: { "content-type": "application/json" },
                method: "POST",
              })
            );

            return { body: await response.text(), status: response.status };
          }).pipe(
            Effect.flatMap(({ body, status }) =>
              decodeDelivery(objectName, status, body)
            ),
            Effect.flatMap((outcome) =>
              request.headers.has("x-test-crash-after-journal")
                ? Effect.die("crash after run journal, before receipt")
                : Effect.succeed(outcome)
            )
          ),
      })
    );

    const exit = await Effect.runPromiseExit(
      this.box
        .receive({
          body: "keep this record",
          messageId: "reply-record",
          replyTo: Option.some(ask),
          senderDid: "did:web:sender",
        })
        .pipe(Effect.provide(Layer.merge(this.layer, runs)))
    );

    return Response.json({ ok: Exit.isSuccess(exit) });
  }
}
