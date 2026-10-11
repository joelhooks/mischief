import { Schema } from "effect";
import { absurd } from "effect/Function";

import type { Plan, StateNode, Step } from "./schema.js";

const DOC_REF = /\{\{docs\.(?<name>[a-z][a-z0-9_-]{0,63})\}\}/gu;

export const docRefs = (text: string) =>
  [...text.matchAll(DOC_REF)].flatMap((match) =>
    match.groups?.name === undefined ? [] : [match.groups.name]
  );

const isText = Schema.is(Schema.String);

export const docText = (doc: Schema.Json) =>
  isText(doc) ? doc : JSON.stringify(doc);

export const interpolate = (
  text: string,
  docs: Readonly<Record<string, Schema.Json>>
) => {
  const missing = docRefs(text).filter((name) => !(name in docs));

  return {
    missing: [...new Set(missing)],
    text: text.replaceAll(DOC_REF, (whole, name: string) => {
      const doc = docs[name];

      return doc === undefined ? whole : docText(doc);
    }),
  };
};

export interface PlacedStep {
  readonly step: Step;
  readonly where: string;
}

const isStepNode = (
  node: StateNode
): node is Extract<StateNode, { readonly meta: { readonly step: Step } }> =>
  "meta" in node && node.meta !== undefined && "step" in node.meta;

export const stepsOf = (
  states: Readonly<Record<string, StateNode>>,
  path: readonly string[] = []
): PlacedStep[] =>
  Object.entries(states).flatMap(([name, node]) => {
    const where = [...path, name];

    if ("states" in node) {
      return stepsOf(node.states, where);
    }

    if (!isStepNode(node)) {
      return [];
    }

    const { step } = node.meta;
    const placed = { step, where: where.join(".") };

    if (step.kind !== "parallel") {
      return [placed];
    }

    return [
      placed,
      ...Object.entries(step.branches).flatMap(([branch, { states: inner }]) =>
        Object.entries(inner).flatMap(([innerName, innerNode]) =>
          "meta" in innerNode
            ? [
                {
                  step: innerNode.meta.step,
                  where: [...where, branch, innerName].join("."),
                },
              ]
            : []
        )
      ),
    ];
  });

const refsOf = (step: Step): readonly string[] => {
  switch (step.kind) {
    case "think": {
      return docRefs(step.prompt);
    }

    case "ask": {
      return docRefs(step.message);
    }

    case "ask-joel":
    case "judge":
    case "parallel":
    case "sketch": {
      return [];
    }

    default: {
      return absurd(step);
    }
  }
};

export const docRefErrors = (plan: Plan, seeded: readonly string[]) => {
  const steps = stepsOf(plan.machine.states);

  const known = new Set([
    ...seeded,
    ...steps.flatMap(({ step }) =>
      "writes" in step && step.writes !== undefined ? [step.writes] : []
    ),
  ]);

  const listed = [...known].toSorted().join(", ") || "none";

  return steps.flatMap(({ step, where }) =>
    [...new Set(refsOf(step))].flatMap((name) =>
      known.has(name)
        ? []
        : [
            `${where}: doc "${name}" is not written by any step and not seeded. Docs available: ${listed}. Fix the name, add writes: "${name}" to the step that produces it, or seed it with submitPlan --docs`,
          ]
    )
  );
};
