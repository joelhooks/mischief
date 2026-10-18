import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunStore } from "../../src/runs/run-store.js";
import type { QuestionInput } from "../../src/steps/inputs.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { ThinkModelUnmapped } from "../../src/steps/think-model-unmapped.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const WorldSchema = Schema.Struct({
  model: Schema.Literals([
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ]),
  passed: Schema.Literals([0.3, 0.5, 0.7]),
});

const planFor = (model: string) => ({
  defaults: { agent: { model } },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "medium",
    models: ["jev", model],
    names: [],
    thresholds: { judge: 0.8, think: 0.6 },
  },
  goal: "Judge with a think model the host does not map",
  id: "gate",
  machine: {
    id: "gate",
    initial: "gate",
    states: {
      failed: { type: "final" },
      gate: {
        meta: { step: { kind: "judge", question: "Does the gate hold?" } },
        on: { failed: { target: "failed" }, passed: { target: "passed" } },
      },
      passed: { type: "final" },
    },
  },
});

it.effect.prop(
  "a sub-threshold verdict whose think model is unmapped escalates with ThinkModelUnmapped naming that model, and keeps the reason through a restart and a revision",
  { world: Arbitrary.schema(WorldSchema) },
  ({ world }) =>
    Effect.gen(function* unmapped() {
      const mailed: QuestionInput[] = [];

      const hostOn = RunHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Layer.succeed(
              Judge,
              Judge.of({
                choose: () =>
                  Effect.succeed({
                    probabilities: {
                      failed: 1 - world.passed,
                      passed: world.passed,
                    },
                    usage: { tokens: 1 },
                  }),
              })
            ),
            Layer.succeed(
              Thinker,
              Thinker.of({
                decide: ({ agent, key }) =>
                  Effect.fail(
                    new ThinkModelUnmapped({
                      key,
                      mapped: ["gpt-6.1-sol", "sol"],
                      model: agent.model ?? "",
                    })
                  ),
                elaborate: () => Effect.die("no elaborate in this plan"),
                think: () => Effect.die("no think step in this plan"),
              })
            ),
            Mail.unwired,
            Layer.succeed(
              Operator,
              Operator.of({
                notify: (_runId, question) =>
                  Effect.sync(() => {
                    mailed.push(question);
                  }),
              })
            )
          )
        )
      );

      const plan = planFor(world.model);
      const runs = yield* hostOn;
      const submitted = yield* runs.submit("gate", plan);

      expect(submitted.status).toBe("waiting-for-joel");
      expect(submitted.question?.reason ?? "").toMatch(
        new RegExp(`^ThinkModelUnmapped: .*"${world.model}"`, "u")
      );
      expect(mailed.map(({ reason }) => reason)).toStrictEqual([
        submitted.question?.reason,
      ]);

      const restarted = yield* hostOn;
      const again = yield* restarted.advance("gate");

      expect(again.question?.reason).toBe(submitted.question?.reason);

      const revised = yield* restarted.revise(
        "gate",
        { ...plan, goal: "Revised" },
        false
      );

      expect(revised.run.question?.reason).toBe(submitted.question?.reason);
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 30 } }
);
