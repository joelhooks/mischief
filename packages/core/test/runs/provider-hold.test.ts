import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import type { Held } from "../../src/runs/schema.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import {
  ProviderCauseSchema,
  ProviderUnavailable,
} from "../../src/steps/provider-unavailable.js";
import { Thinker } from "../../src/steps/thinker.js";

const gatePlan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "One judged gate",
  id: "gate",
  machine: {
    id: "gate",
    initial: "check",
    states: {
      check: {
        meta: { step: { kind: "judge", question: "Does it hold?" } },
        on: { failed: { target: "failed" }, passed: { target: "passed" } },
      },
      failed: { type: "final" },
      passed: { type: "final" },
    },
  },
};

const WorldSchema = Schema.Struct({
  choice: Schema.Literals(["passed", "failed"]),
  outages: Schema.Array(
    Schema.Struct({ cause: ProviderCauseSchema, restart: Schema.Boolean })
  ).check(Schema.isMaxLength(4)),
});

it.effect.prop(
  "a provider outage holds the run waiting-for-provider with a typed reason, announces each hold once, and resumeRun asks the judge again until it decides as if nothing failed",
  { world: Arbitrary.schema(WorldSchema) },
  ({ world }) =>
    Effect.gen(function* providerHold() {
      const remaining = { outages: [...world.outages] };
      const asked = { count: 0 };
      const notices: string[] = [];
      const announced: Held[] = [];

      const judge = Layer.succeed(
        Judge,
        Judge.of({
          choose: ({ key }) =>
            Effect.suspend(() => {
              asked.count += 1;

              const [outage, ...rest] = remaining.outages;

              if (outage === undefined) {
                return Effect.succeed({
                  probabilities: { [world.choice]: 1 },
                  usage: { tokens: 3 },
                });
              }

              remaining.outages = rest;

              return Effect.fail(
                new ProviderUnavailable({
                  cause: outage.cause,
                  key,
                  provider: "jev",
                  status: outage.cause === "billing" ? 402 : null,
                })
              );
            }),
        })
      );

      const hostNow = RunHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            judge,
            Thinker.unwired,
            Mail.unwired,
            Layer.succeed(
              Operator,
              Operator.of({
                held: (_runId, held, notice) =>
                  Effect.sync(() => {
                    notices.push(notice);
                    announced.push(held);
                  }),
                notify: () => Effect.void,
              })
            )
          )
        )
      );

      let runs = yield* hostNow;
      let report = yield* runs.submit("held", gatePlan);

      for (const outage of world.outages) {
        expect(report.status, "an outage never ends the run").toBe(
          "waiting-for-provider"
        );
        expect(report.failures ?? []).toStrictEqual([]);
        expect(
          report.held?.map(({ cause, key, provider }) => ({
            cause,
            key,
            provider,
          }))
        ).toStrictEqual([
          { cause: outage.cause, key: "check", provider: "jev" },
        ]);

        if (outage.restart) {
          runs = yield* hostNow;
        }

        report = yield* runs.resume("held");
      }

      expect(report.status).toBe("done");
      expect(report.value).toBe(world.choice);
      expect(report.held).toBeUndefined();
      expect(asked.count).toBe(world.outages.length + 1);

      expect(
        notices,
        "one hold is one notice, however often the judge fails again inside it"
      ).toStrictEqual(world.outages.length > 0 ? ["held:check#1"] : []);

      expect(announced.map(({ cause }) => cause)).toStrictEqual(
        world.outages.slice(0, 1).map(({ cause }) => cause)
      );
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 60 } }
);
