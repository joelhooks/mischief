import { isCompound, isStep } from "./compile.js";
import type { Amendment, CompoundState, Plan, SketchStep } from "./schema.js";

export interface AmendPoint {
  readonly next: string;
  readonly path: readonly string[];
}

const replaceSketch = (
  states: CompoundState["states"],
  path: readonly string[],
  elaborate: (sketch: SketchStep) => CompoundState
): CompoundState["states"] => {
  const [head, ...tail] = path;
  const node = head === undefined ? undefined : states[head];

  if (head === undefined || node === undefined) {
    return states;
  }

  if (tail.length > 0) {
    return isCompound(node)
      ? {
          ...states,
          [head]: {
            ...node,
            states: replaceSketch(node.states, tail, elaborate),
          },
        }
      : states;
  }

  if (!isStep(node) || node.meta.step.kind !== "sketch") {
    return states;
  }

  return { ...states, [head]: elaborate(node.meta.step) };
};

export const amendPlan = (
  plan: Plan,
  point: AmendPoint,
  amendment: Amendment
): Plan => ({
  ...plan,
  machine: {
    ...plan.machine,
    states: replaceSketch(plan.machine.states, point.path, (sketch) => ({
      description: sketch.goal,
      initial: amendment.initial,
      meta: { elaboratedFrom: sketch, version: plan.version + 1 },
      on: {
        [`xstate.done.state.${plan.machine.id}.${point.path.join(".")}`]: {
          target: point.next,
        },
      },
      states: amendment.states,
    })),
  },
  version: plan.version + 1,
});
