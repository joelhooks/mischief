import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";

const SEEDS = ["brief", "notes", "style"] as const;

const plan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 10,
    maxDepth: 3,
    maxSteps: 200,
    maxThinking: "low",
    models: ["sol"],
    names: ["desk"],
    thresholds: { judge: 0.8 },
  },
  goal: "ask the desk until Joel is happy",
  id: "loop",
  machine: {
    id: "loop",
    initial: "ask",
    states: {
      ask: {
        meta: {
          step: {
            kind: "ask",
            message: "how is it?",
            to: "desk",
            writes: "reply",
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

const services = Layer.mergeAll(
  NodeCrypto.layer,
  RunStore.memory,
  Layer.succeed(
    Thinker,
    Thinker.of({
      decide: () => Effect.die("unused"),
      elaborate: () => Effect.die("unused"),
      think: () => Effect.die("unused"),
    })
  ),
  Layer.succeed(Judge, Judge.of({ choose: () => Effect.die("unused") })),
  Layer.succeed(
    Mail,
    Mail.of({
      seal: ({ key, message, runId, visit }) =>
        Effect.succeed({
          envelope: message,
          messageId: `${runId}/${key}#${visit}`,
        }),
      send: () => Effect.void,
    })
  ),
  Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
);

const RoundSchema = Schema.Struct({
  body: Schema.String.check(Schema.isMaxLength(20)),
  stray: Schema.Boolean,
});

it.effect.prop(
  "every reply and answer the run consumes is logged once, in order, beside the seeded doc names",
  {
    rounds: Arbitrary.schema(
      Schema.Array(RoundSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(4)
      )
    ),
    seeds: Arbitrary.schema(Schema.Array(Schema.Literals(SEEDS))),
  },
  ({ rounds, seeds }) =>
    Effect.gen(function* property() {
      const host = yield* RunHost.make;
      const store = yield* RunStore;
      const docs = Object.fromEntries(seeds.map((name) => [name, name]));

      let report = yield* host.submit("run", plan, docs);

      for (const [index, { body, stray }] of rounds.entries()) {
        const [open] = report.awaiting ?? [];

        expect(report.status).toBe("waiting-for-reply");

        report = yield* host.deliver({
          body,
          from: "desk",
          replyTo: open?.messageId ?? "",
        });

        if (stray) {
          yield* Effect.exit(host.answer("run", "maybe"));
        }

        report = yield* host.answer(
          "run",
          index === rounds.length - 1 ? "done" : "again"
        );
      }

      expect(report.status).toBe("done");

      const logged = [...(yield* store.readJournal("run"))].filter(
        ([key]) => key.startsWith("reply:") || key.startsWith("answer:")
      );

      expect(Object.fromEntries(logged)).toEqual(
        Object.fromEntries(
          rounds.flatMap(({ body }, index) => [
            [`reply:run/ask#${index + 1}`, body],
            [
              `answer:gate#${index + 1}`,
              index === rounds.length - 1 ? "done" : "again",
            ],
          ])
        )
      );
      expect(logged).toHaveLength(rounds.length * 2);

      const state = Option.getOrThrow(yield* store.readRun("run"));

      expect(state.seeded).toEqual([...new Set(seeds)].toSorted());
    }).pipe(Effect.provide(services)),
  { arbitrary: { runs: 60 } }
);
