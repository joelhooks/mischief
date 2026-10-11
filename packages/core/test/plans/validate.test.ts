import { expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { isStep } from "../../src/plans/compile.js";
import { validatePlan } from "../../src/plans/validate.js";
import { launchNotePlan } from "../runs/launch-note.js";

const OPTIONS = ["enough", "thin"];

it.effect.prop(
  "a judge's fallback is accepted exactly when it names one of its transitions",
  {
    fallback: Arbitrary.schema(
      Schema.Literals(["enough", "thin", "draft", "Enough", ""])
    ),
  },
  ({ fallback }) =>
    Effect.gen(function* property() {
      const { assess } = launchNotePlan.machine.states;

      const exit = yield* Effect.exit(
        validatePlan({
          ...launchNotePlan,
          machine: {
            ...launchNotePlan.machine,
            states: {
              ...launchNotePlan.machine.states,
              assess: {
                ...assess,
                meta: { step: { ...assess.meta.step, fallback } },
              },
            },
          },
          version: 1,
        })
      );

      if (OPTIONS.includes(fallback)) {
        expect(Exit.isSuccess(exit)).toBe(true);
      } else {
        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
          `assess: fallback "${fallback}" is not one of its transitions. Use one of: ${OPTIONS.join(", ")}`
        );
      }
    }),
  { arbitrary: { runs: 40 } }
);

it.effect.prop(
  "a plan that still sets envelope.budgetTokens is refused with the fix",
  {
    budget: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 100_000, minimum: 0 }))
    ),
  },
  ({ budget }) =>
    Effect.gen(function* property() {
      const exit = yield* Effect.exit(
        validatePlan({
          ...launchNotePlan,
          envelope: { ...launchNotePlan.envelope, budgetTokens: budget },
          version: 1,
        })
      );

      expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
        "envelope.budgetTokens was removed: workers get no token budgets, and maxSteps is the run's guard. Delete the field"
      );
    }),
  { arbitrary: { runs: 20 } }
);

const POOL = ["effect", "seo", "tdd"] as const;

const Subset = Arbitrary.schema(
  Schema.Array(Schema.Literals(POOL)).check(Schema.isMaxLength(3))
);

const specialistPlan = (
  field: "extensions" | "skills",
  allowed: readonly string[],
  defaults: readonly string[],
  own: readonly string[] | undefined
) => ({
  defaults: { agent: { [field]: defaults } },
  envelope: {
    maxAgents: 1,
    maxDepth: 2,
    maxSteps: 5,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    [field]: allowed,
    thresholds: { judge: 0.8 },
  },
  goal: "One specialist",
  id: "specialist",
  machine: {
    id: "specialist",
    initial: "work",
    states: {
      done: { type: "final" },
      work: {
        meta: {
          step: {
            agent: own === undefined ? {} : { [field]: own },
            kind: "think",
            prompt: "go",
          },
        },
        on: { done: { target: "done" } },
      },
    },
  },
  version: 1,
});

it.effect.prop(
  "a think step's own skills or extensions replace the plan defaults, and only allowlisted ones pass",
  {
    allowed: Subset,
    defaults: Subset,
    field: Arbitrary.schema(Schema.Literals(["extensions", "skills"])),
    own: Arbitrary.schema(
      Schema.UndefinedOr(Schema.Array(Schema.Literals(POOL)))
    ),
  },
  ({ allowed, defaults, field, own }) =>
    Effect.gen(function* property() {
      const exit = yield* Effect.exit(
        validatePlan(specialistPlan(field, allowed, defaults, own))
      );

      const merged = [...new Set(own ?? defaults)];
      const outside = merged.filter((skill) => !allowed.includes(skill));

      if (outside.length > 0) {
        expect(Exit.isFailure(exit)).toBe(true);

        for (const skill of outside) {
          expect(String(Exit.isFailure(exit) && exit.cause)).toContain(
            `work: ${field.slice(0, -1)} "${skill}" is outside the envelope. Allowed: ${allowed.join(", ") || "none"}, or add it to envelope.${field}`
          );
        }

        return;
      }

      expect(Exit.isSuccess(exit)).toBe(true);

      const work = Exit.isSuccess(exit)
        ? exit.value.machine.states.work
        : undefined;

      expect(
        work !== undefined && isStep(work) && work.meta.step.kind === "think"
          ? work.meta.step.agent?.[field]
          : undefined
      ).toEqual(merged);
    }),
  { arbitrary: { runs: 80 } }
);
