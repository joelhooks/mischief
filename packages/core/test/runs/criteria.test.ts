import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { missingCriteria } from "../../src/plans/criteria.js";
import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";

const YES = "the receipt shows every part of the bar holds";

const NO = "some part does not hold, or the receipt lacks the evidence";

const planWith = (criteria: Readonly<Record<string, string>> | null) => ({
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
  goal: "Audit once",
  id: "audit",
  machine: {
    id: "audit",
    initial: "audit",
    states: {
      audit: {
        meta: {
          step:
            criteria === null
              ? { kind: "judge", question: "Does `docs.receipt` meet the bar?" }
              : {
                  criteria,
                  kind: "judge",
                  question: "Does `docs.receipt` meet the bar?",
                },
        },
        on: { no: { target: "repair" }, yes: { target: "done" } },
      },
      done: { type: "final" },
      repair: { type: "final" },
    },
  },
});

const CoverageSchema = Schema.Literals(["none", "both", "only yes", "extra"]);

const criteriaOf = (coverage: typeof CoverageSchema.Type) =>
  ({
    both: { no: NO, yes: YES },
    extra: { maybe: "unsure", no: NO, yes: YES },
    none: null,
    "only yes": { yes: YES },
  })[coverage];

const WorldSchema = Schema.Struct({
  admits: Schema.Boolean,
  p: Schema.Literals([0.05, 0.5, 0.95]),
  revise: CoverageSchema,
  submit: CoverageSchema,
});

it.effect.prop(
  "criteria must name exactly a judge's transitions; a judge that requires them refuses submit and revise without them, naming the step; the step's criteria reach the judge",
  { world: Arbitrary.schema(WorldSchema) },
  ({ world }) =>
    Effect.gen(function* criteria() {
      const seen: unknown[] = [];

      const choose: Judge["Service"]["choose"] = (call) =>
        Effect.sync(() => {
          seen.push(call.criteria);

          return {
            probabilities: { no: 1 - world.p, yes: world.p },
            usage: { tokens: 1 },
          };
        });

      const judge = Layer.succeed(
        Judge,
        Judge.of(
          world.admits
            ? { admits: (plan) => missingCriteria(plan, "jev"), choose }
            : { choose }
        )
      );

      const runs = yield* RunHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            judge,
            Thinker.unwired,
            Mail.unwired,
            Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
          )
        )
      );

      const accepted = (coverage: typeof CoverageSchema.Type) =>
        coverage === "both" || (coverage === "none" && !world.admits);

      const submitted = yield* Effect.exit(
        runs.submit("audit", planWith(criteriaOf(world.submit)))
      );

      expect(Exit.isSuccess(submitted)).toBe(accepted(world.submit));

      if (Exit.isFailure(submitted)) {
        const refusal = String(submitted.cause);

        expect(refusal).toContain("audit");
        expect(refusal).toMatch(
          world.submit === "none"
            ? /needs criteria/u
            : /exactly its transitions/u
        );
        expect(seen).toHaveLength(0);

        return;
      }

      expect(seen).toStrictEqual([criteriaOf(world.submit) ?? undefined]);

      const revised = yield* Effect.exit(
        runs.revise(
          "audit",
          { ...planWith(criteriaOf(world.revise)), goal: "Audit again" },
          false
        )
      );

      expect(Exit.isSuccess(revised)).toBe(accepted(world.revise));
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 60 } }
);
