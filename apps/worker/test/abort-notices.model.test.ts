import { expect, it } from "@effect/vitest";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Layer, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { Mailroom, SendVerdict } from "../src/mailroom-port.js";
import { postbox } from "../src/postbox.js";
import { Delivered, Runs } from "../src/runs-port.js";

const Event = Schema.Struct({
  kind: Schema.Literals([
    "deliver",
    "advance",
    "resolve",
    "fail",
    "abort",
    "restart",
  ]),
  reply: Schema.Int.check(Schema.isBetween({ maximum: 2, minimum: 0 })),
  run: Schema.Int.check(Schema.isBetween({ maximum: 2, minimum: 0 })),
});

const History = Schema.Array(Event).check(Schema.isMaxLength(40));

const historyHolds = (history: typeof History.Type) =>
  Effect.gen(function* playedHistory() {
    const storage = nodeSqlStorage(":memory:");
    let box = postbox(storage);
    const statuses = new Map<string, string>();
    const accepted = new Map<string, string>();
    const expected = new Set<string>();
    const sent: string[] = [];
    const bodies = new Map<string, string>();

    const mailroom = Layer.succeed(
      Mailroom,
      Mailroom.of({
        nameOf: (did) => Effect.succeedSome(did),
        seal: (to, body) =>
          Effect.sync(() => {
            const envelope = `${bodies.size}:${to}:${body}`;
            bodies.set(envelope, body);

            return { envelope, messageId: body };
          }),
        send: (envelope) =>
          Effect.sync(() => {
            sent.push(envelope);

            return SendVerdict.cases.Accepted.make({});
          }),
        surface: () => Effect.void,
        tell: () => Effect.void,
      })
    );

    const runs = Layer.succeed(
      Runs,
      Runs.of({
        deliver: (runId) =>
          Effect.succeed(
            statuses.has(runId)
              ? Delivered.cases.Refused.make({ reason: "the run ended" })
              : Delivered.cases.Journaled.make({})
          ),
      })
    );

    const layer = Layer.merge(mailroom, runs);

    for (const run of [0, 1, 2]) {
      yield* box
        .seal(`run-${run}`, "sender", `ask-${run}`)
        .pipe(Effect.provide(mailroom));
    }

    for (const [seq, event] of history.entries()) {
      const runId = `run-${event.run}`;
      const id = `reply-${event.run}-${event.reply}`;

      switch (event.kind) {
        case "deliver": {
          if (!statuses.has(runId)) {
            accepted.set(id, runId);
          }

          yield* box
            .receive(
              {
                body: id,
                messageId: id,
                replyTo: Option.some(`ask-${event.run}`),
                senderDid: "sender",
              },
              seq
            )
            .pipe(Effect.provide(layer));
          break;
        }

        case "resolve":
        case "fail": {
          if (!statuses.has(runId)) {
            statuses.set(runId, event.kind);
          }

          break;
        }

        case "abort": {
          if (!statuses.has(runId)) {
            statuses.set(runId, "aborted");

            for (const [messageId, owner] of accepted) {
              if (owner === runId) {
                expected.add(messageId);
              }
            }
          }

          if (statuses.get(runId) === "aborted") {
            yield* box
              .abort(runId, "wakeTimeout")
              .pipe(Effect.provide(mailroom));
            yield* box
              .abort(runId, "redelivered abort")
              .pipe(Effect.provide(mailroom));
          }

          break;
        }

        case "restart": {
          box = postbox(storage);
          break;
        }

        case "advance": {
          break;
        }

        default: {
          break;
        }
      }

      expect(sent.length).toBe(expected.size);

      for (const messageId of expected) {
        expect(
          sent.filter(
            (envelope) =>
              bodies
                .get(envelope)
                ?.includes(`Your reply ${messageId} reached`) === true
          )
        ).toHaveLength(1);
      }
    }
  });

it.effect.prop(
  "only an abort loses delivered replies, including replies already used by downstream steps, once across retries and restarts",
  { history: Arbitrary.schema(History) },
  ({ history }) => historyHolds(history),
  { arbitrary: { runs: 300 } }
);
