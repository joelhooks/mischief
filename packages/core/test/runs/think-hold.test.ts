import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { ProviderUnavailable } from "../../src/steps/provider-unavailable.js";
import type { ThinkReceipt } from "../../src/steps/receipt.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const thinkPlan = {
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: 1,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Think once through an overloaded proxy",
  id: "draft",
  machine: {
    id: "draft",
    initial: "draft",
    states: {
      done: { type: "final" },
      draft: {
        meta: {
          step: { kind: "think", prompt: "draft it", writes: "draft" },
        },
        on: { done: { target: "done" } },
      },
    },
  },
};

const receipt: ThinkReceipt = {
  effective: { model: "sol", thinking: "low" },
  latencyMs: 1,
  matched: true,
  requested: { from: "plan", model: "sol", thinking: "low" },
  tokens: { cacheRead: 0, input: 2, output: 3, total: 5 },
};

const OutageSchema = Schema.Struct({
  restart: Schema.Boolean,
  status: Schema.Literals([408, 429, 500, 502, 503, 507, 520]),
});

it.effect.prop(
  "a held think parks the run waiting-for-provider, and resume completes it with exactly one recorded think",
  {
    outages: Arbitrary.schema(
      Schema.Array(OutageSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(4)
      )
    ),
  },
  ({ outages }) =>
    Effect.gen(function* thinkHold() {
      const remaining = { outages: [...outages] };
      const asked = { count: 0 };

      const thinker = Layer.succeed(
        Thinker,
        Thinker.of({
          decide: () => Effect.die("no judge in this plan"),
          elaborate: () => Effect.die("no elaborate in this plan"),
          think: ({ key }) =>
            Effect.suspend(() => {
              asked.count += 1;

              const [outage, ...rest] = remaining.outages;

              if (outage === undefined) {
                return Effect.succeed({
                  output: "drafted",
                  receipt,
                  tokens: 5,
                });
              }

              remaining.outages = rest;

              return Effect.fail(
                new ProviderUnavailable({
                  cause: "busy",
                  key,
                  provider: "proxy/sol",
                  status: outage.status,
                })
              );
            }),
        })
      );

      const hostNow = RunHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Judge.unwired,
            Mail.unwired,
            thinker,
            Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
          )
        )
      );

      let runs = yield* hostNow;
      let report = yield* runs.submit("held-think", thinkPlan);

      for (const outage of outages) {
        expect(report.status).toBe("waiting-for-provider");
        expect(report.failures ?? []).toStrictEqual([]);
        expect(
          report.held?.map(({ key, provider, status }) => ({
            key,
            provider,
            status,
          }))
        ).toStrictEqual([
          { key: "draft", provider: "proxy/sol", status: outage.status },
        ]);

        if (outage.restart) {
          runs = yield* hostNow;
        }

        report = yield* runs.resume("held-think");
      }

      expect(report.status).toBe("done");
      expect(report.held).toBeUndefined();
      expect(report.docs).toStrictEqual({ draft: "drafted" });
      expect(report.thinking?.calls, "one recorded think").toBe(1);
      expect(asked.count).toBe(outages.length + 1);
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 40 } }
);
