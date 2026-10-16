import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";

const Level = Schema.Literals(["low", "medium", "high"]);

const WorldSchema = Schema.Struct({
  ceiling: Level,
  planLevel: Schema.optionalKey(Level),
  stepLevel: Schema.optionalKey(Level),
});

const order = ["low", "medium", "high"];

const within = (level: string | undefined, ceiling: string) =>
  level === undefined || order.indexOf(level) <= order.indexOf(ceiling);

const agentWith = (level: string | undefined) =>
  level === undefined ? {} : { thinking: level };

it.effect.prop(
  "a think step reaches the Thinker with the level the plan or step named, or none, and the envelope's ceiling, so the host default fills only what the plan left unset",
  { world: Arbitrary.schema(WorldSchema) },
  ({ world }) =>
    Effect.gen(function* called() {
      const seen: { ceiling: string; thinking: string | undefined }[] = [];

      const runs = yield* RunHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Judge.unwired,
            Mail.unwired,
            Layer.succeed(Operator, Operator.of({ notify: () => Effect.void })),
            Layer.succeed(
              Thinker,
              Thinker.of({
                decide: () => Effect.die("no judge in this plan"),
                elaborate: () => Effect.die("no elaborate in this plan"),
                think: ({ agent, ceiling }) =>
                  Effect.sync(() => {
                    seen.push({ ceiling, thinking: agent.thinking });

                    return { output: "ok", tokens: 0 };
                  }),
              })
            )
          )
        )
      );

      const submitted = yield* Effect.result(
        runs.submit("think", {
          defaults: { agent: { model: "sol", ...agentWith(world.planLevel) } },
          envelope: {
            maxAgents: 1,
            maxDepth: 3,
            maxSteps: 10,
            maxThinking: world.ceiling,
            models: ["sol"],
            names: [],
            thresholds: { judge: 0.8 },
          },
          goal: "Think once",
          id: "think",
          machine: {
            id: "think",
            initial: "think",
            states: {
              done: { type: "final" },
              think: {
                meta: {
                  step: {
                    agent: agentWith(world.stepLevel),
                    kind: "think",
                    prompt: "think",
                  },
                },
                on: { done: { target: "done" } },
              },
            },
          },
        })
      );

      const named = world.stepLevel ?? world.planLevel;

      expect(Result.isSuccess(submitted)).toBe(within(named, world.ceiling));

      if (Result.isFailure(submitted)) {
        expect(seen).toStrictEqual([]);

        return;
      }

      expect(submitted.success.status).toBe("done");
      expect(seen).toStrictEqual([{ ceiling: world.ceiling, thinking: named }]);
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 60 } }
);
