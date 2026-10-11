import { expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

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
