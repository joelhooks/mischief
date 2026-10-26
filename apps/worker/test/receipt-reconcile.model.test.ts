import { expect, it } from "@effect/vitest";
import {
  Drive,
  Judge,
  Mail,
  Operator,
  ReplyRefused,
  RunHost,
  RunStore,
  Thinker,
} from "@mischief/core";
import { webCrypto } from "@mischief/plan-run";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Exit, Layer, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { decodeDelivery } from "../src/decode-delivery.js";
import { Mailroom, SendVerdict } from "../src/mailroom-port.js";
import { postbox } from "../src/postbox.js";
import { Delivered, Runs } from "../src/runs-port.js";

const plan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 100,
    maxThinking: "low",
    models: ["sol"],
    names: ["sender/desk"],
    thresholds: { judge: 0.8 },
  },
  goal: "Keep replies until abort",
  id: "records",
  machine: {
    id: "records",
    initial: "ask",
    states: {
      ask: {
        meta: {
          step: {
            kind: "ask",
            message: "record?",
            to: "sender/desk",
            writes: "record",
          },
        },
        on: { replied: { target: "gate" } },
      },
      end: { type: "final" },
      gate: {
        meta: { step: { kind: "ask-joel", question: "again?" } },
        on: { again: { target: "ask" }, done: { target: "end" } },
      },
    },
  },
};

const History = Schema.Array(
  Schema.Struct({
    body: Schema.String.check(Schema.isMaxLength(20)),
    retries: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
  })
).check(Schema.isMinLength(1), Schema.isMaxLength(5));

it.effect.prop(
  "a run-accepted reply survives the crash before its Postbox receipt, redelivery and abort",
  { history: Arbitrary.schema(History) },
  ({ history }) =>
    Effect.gen(function* reconcile() {
      const storage = nodeSqlStorage(":memory:");
      let box = postbox(storage);
      const notices: string[] = [];

      const mailroom = Layer.succeed(
        Mailroom,
        Mailroom.of({
          nameOf: () => Effect.succeedSome("sender/desk"),
          seal: (to, body) =>
            Effect.succeed({ envelope: `${to}:${body}`, messageId: body }),
          send: (envelope) =>
            Effect.sync(() => {
              notices.push(envelope);

              return SendVerdict.cases.Accepted.make({});
            }),
          surface: () => Effect.void,
          tell: () => Effect.void,
        })
      );

      const services = Layer.mergeAll(
        webCrypto,
        RunStore.memory,
        Drive.inline,
        Layer.succeed(Judge, Judge.of({ choose: () => Effect.die("unused") })),
        Layer.succeed(
          Thinker,
          Thinker.of({
            decide: () => Effect.die("unused"),
            elaborate: () => Effect.die("unused"),
            think: () => Effect.die("unused"),
          })
        ),
        Layer.succeed(Operator, Operator.of({ notify: () => Effect.void })),
        Layer.succeed(
          Mail,
          Mail.of({
            seal: ({ key, message, runId, visit }) =>
              box
                .seal(runId, "sender/desk", `${message}:${key}:${visit}`)
                .pipe(Effect.provide(mailroom), Effect.orDie),
            send: () => Effect.void,
          })
        )
      );

      yield* Effect.gen(function* play() {
        let host = yield* RunHost.make;
        let report = yield* host.submit("run", plan);
        let crash = false;

        const runs = Layer.succeed(
          Runs,
          Runs.of({
            deliver: (_runId, line) =>
              host.deliver(line).pipe(
                Effect.map(() => Delivered.cases.Journaled.make({})),
                Effect.catch((error) =>
                  decodeDelivery("run", 500, JSON.stringify(error))
                ),
                Effect.flatMap((outcome) =>
                  crash
                    ? Effect.die("crash after run acceptance, before receipt")
                    : Effect.succeed(outcome)
                )
              ),
          })
        );

        const receive = (
          message: Parameters<typeof box.receive>[0],
          seq: number
        ) =>
          box
            .receive(message, seq)
            .pipe(Effect.provide(Layer.merge(mailroom, runs)));

        for (const [index, event] of history.entries()) {
          const ask = report.awaiting?.[0];
          expect(ask).toBeDefined();

          const message = {
            body: event.body,
            messageId: `reply-${index}`,
            replyTo: Option.some(ask?.messageId ?? ""),
            senderDid: "sender",
          };

          crash = true;
          yield* Effect.exit(receive(message, index + 1));
          expect(
            storage.sql
              .exec(
                "SELECT * FROM postbox_delivered WHERE message_id = ?",
                message.messageId
              )
              .toArray()
          ).toHaveLength(0);
          crash = false;
          host = yield* RunHost.make;
          box = postbox(storage);

          for (const changed of [
            { body: `${event.body}!`, from: "sender/desk" },
            { body: event.body, from: "impostor" },
          ]) {
            const refused = yield* Effect.exit(
              host.deliver({
                ...changed,
                messageId: message.messageId,
                replyTo: ask?.messageId ?? "",
              })
            );

            expect(
              Schema.is(ReplyRefused)(
                Option.getOrUndefined(Exit.findErrorOption(refused))
              )
            ).toBe(true);
          }

          for (let retry = 0; retry < event.retries; retry += 1) {
            yield* receive(message, index + 1);
            box = postbox(storage);
          }

          expect(
            storage.sql
              .exec(
                "SELECT message_id, run_id, sender FROM postbox_delivered WHERE message_id = ?",
                message.messageId
              )
              .toArray()
          ).toEqual([
            {
              message_id: message.messageId,
              run_id: "run",
              sender: "sender/desk",
            },
          ]);
          expect(
            storage.sql.exec("SELECT * FROM postbox_parked").toArray()
          ).toHaveLength(0);
          report = yield* host.answer("run", "again");
        }

        yield* host.abort("run");
        yield* box.abort("run", "requested").pipe(Effect.provide(mailroom));
        box = postbox(storage);
        yield* box.abort("run", "retry").pipe(Effect.provide(mailroom));
        expect(notices).toHaveLength(history.length);

        for (const index of history.keys()) {
          expect(
            notices.filter((notice) =>
              notice.includes(`Your reply reply-${index} reached`)
            )
          ).toHaveLength(1);
        }
      }).pipe(Effect.provide(services));
    }),
  { arbitrary: { runs: 100 } }
);
