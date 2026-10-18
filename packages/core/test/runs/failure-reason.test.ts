import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { StepFailed } from "../../src/steps/step-failed.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const STEPS = ["draft", "review", "polish"] as const;

const envelope = {
  maxAgents: 10,
  maxDepth: 3,
  maxSteps: 100,
  maxThinking: "low",
  models: ["sol"],
  names: [],
  thresholds: { judge: 0.8 },
};

const thinkThen = (name: string, target: string) => ({
  meta: { step: { kind: "think", prompt: name, writes: name } },
  on: { done: { target } },
});

const chain = () => ({
  draft: thinkThen("draft", "review"),
  end: { type: "final" },
  polish: thinkThen("polish", "end"),
  review: thinkThen("review", "polish"),
});

const planOf = (inBranch: boolean) => ({
  defaults: { agent: {} },
  envelope,
  goal: "fail with a reason",
  id: "reasons",
  machine: {
    id: "reasons",
    initial: inBranch ? "fan" : STEPS[0],
    states: inBranch
      ? {
          end: { type: "final" },
          fan: {
            meta: {
              step: {
                branches: {
                  lane: { initial: STEPS[0], states: chain() },
                  other: {
                    initial: "idle",
                    states: {
                      end: { type: "final" },
                      idle: thinkThen("idle", "end"),
                    },
                  },
                },
                join: "allSettled",
                kind: "parallel",
              },
            },
            on: { done: { target: "end" } },
          },
        }
      : chain(),
  },
});

const servicesFor = (failing: string, reason: string) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    RunStore.memory,
    Layer.succeed(
      Thinker,
      Thinker.of({
        decide: () => Effect.die("unused"),
        elaborate: () => Effect.die("unused"),
        think: ({ key, prompt }) =>
          prompt === failing
            ? Effect.fail(new StepFailed({ key, reason }))
            : Effect.succeed({ output: prompt, tokens: 1 }),
      })
    ),
    Layer.succeed(Judge, Judge.of({ choose: () => Effect.die("unused") })),
    Layer.succeed(
      Mail,
      Mail.of({
        seal: () => Effect.die("unused"),
        send: () => Effect.die("unused"),
      })
    ),
    Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
  );

it.effect.prop(
  "a failed step journals its reason and inspectRun shows it, at the top level and in a branch",
  {
    failing: Arbitrary.schema(Schema.Literals(STEPS)),
    inBranch: Arbitrary.schema(Schema.Boolean),
    reason: Arbitrary.schema(
      Schema.Literals([
        "Gateway thinking failed. Check the endpoint, then resume the run.",
        "409 Conflict",
        "the judge timed out; raise its limit or retry",
      ])
    ),
  },
  ({ failing, inBranch, reason }) =>
    Effect.gen(function* property() {
      const host = yield* RunHost.make;

      yield* host.submit("run", planOf(inBranch));

      const journal = yield* (yield* RunStore).readJournal("run");

      const failedKeys = [...journal].filter(
        ([key, entry]) =>
          key.startsWith("logic:") &&
          Schema.is(Schema.Struct({ error: Schema.String }))(entry)
      );

      expect(failedKeys).toHaveLength(1);

      const [key, entry] = failedKeys[0] ?? ["", null];

      expect(key).toContain(`.${failing}#1`);
      expect(entry).toEqual({ error: `${key} failed`, reason });

      const report = yield* (yield* RunHost.make).inspect("run");

      expect(report.failures).toEqual([{ key, reason }]);
    }).pipe(Effect.provide(servicesFor(failing, reason))),
  { arbitrary: { runs: 60 } }
);
