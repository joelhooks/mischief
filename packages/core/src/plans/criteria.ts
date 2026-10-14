import { stepsOf } from "./doc-refs.js";
import type { Plan } from "./schema.js";

export const missingCriteria = (plan: Plan, judge: string) =>
  stepsOf(plan.machine.states).flatMap(({ step, where }) =>
    step.kind === "judge" && step.criteria === undefined
      ? [
          `${where}: judge "${judge}" needs criteria, one description per transition in on saying what choosing it means, such as {"criteria": {"yes": "the receipt shows every part of the bar holds", "no": "some part does not hold, or the receipt lacks the evidence"}}. A judge with transitions yes and no is asked as a yes/no question`,
        ]
      : []
  );
