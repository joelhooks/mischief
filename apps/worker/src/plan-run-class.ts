import type { Callable } from "@mischief/core";

import { PlanRun as BasePlanRun } from "./plan-run-object.js";
import type { Env } from "./plan-run-object.js";

export const planRunClass = (callables: ReadonlyMap<string, Callable>) => {
  const ParentPlanRun = BasePlanRun;

  return class PlanRun extends ParentPlanRun {
    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env, callables);
    }
  };
};
