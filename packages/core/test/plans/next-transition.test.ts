import { expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { validatePlan } from "../../src/plans/validate.js";

const NEXT = { ask: "replied", think: "done" } as const;

const stepOf = (kind: "ask" | "think") =>
  kind === "ask"
    ? { kind, message: "hi", to: "desk", writes: "reply" }
    : { kind, prompt: "go" };

const planWith = (
  kind: "ask" | "think",
  names: readonly string[],
  inBranch: boolean
) => {
  const node = {
    meta: { step: stepOf(kind) },
    on: Object.fromEntries(names.map((name) => [name, { target: "end" }])),
  };

  const fan = {
    meta: {
      step: {
        branches: {
          only: {
            initial: "work",
            states: { end: { type: "final" }, work: node },
          },
          other: {
            initial: "work",
            states: {
              end: { type: "final" },
              work: {
                meta: { step: stepOf("think") },
                on: { done: { target: "end" } },
              },
            },
          },
        },
        join: "allSettled",
        kind: "parallel",
      },
    },
    on: { done: { target: "end" } },
  };

  return {
    defaults: { agent: {} },
    envelope: {
      maxAgents: 10,
      maxDepth: 3,
      maxSteps: 100,
      maxThinking: "low",
      models: ["sol"],
      names: ["desk"],
      thresholds: { judge: 0.8 },
    },
    goal: "one step",
    id: "one",
    machine: {
      id: "one",
      initial: "work",
      states: { end: { type: "final" }, work: inBranch ? fan : node },
    },
    version: 1,
  };
};

it.effect.prop(
  "think needs on.done and ask needs on.replied, at the top level and inside a branch",
  {
    inBranch: Arbitrary.schema(Schema.Boolean),
    kind: Arbitrary.schema(Schema.Literals(["ask", "think"])),
    names: Arbitrary.schema(
      Schema.Array(Schema.Literals(["done", "replied", "failed", "next"]))
    ),
  },
  ({ inBranch, kind, names }) =>
    Effect.gen(function* property() {
      const exit = yield* Effect.exit(
        validatePlan(planWith(kind, names, inBranch))
      );

      const where = inBranch ? "work.only.work" : "work";
      const missing = !names.includes(NEXT[kind]);

      expect(Exit.isSuccess(exit)).toBe(!missing);
      expect(
        String(Exit.isFailure(exit) && exit.cause).includes(
          `${where}: ${kind} needs on.${NEXT[kind]}`
        )
      ).toBe(missing);
    }),
  { arbitrary: { runs: 120 } }
);
