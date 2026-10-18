import type { Callable } from "@mischief/core";

import { planRunClass } from "./plan-run-class.js";
import { Postbox } from "./postbox-object.js";
import { registeredCallables } from "./registered-callables.js";
import { Schedule } from "./schedule-object.js";
import { ServiceTokenLedger } from "./service-tokens.js";
import worker from "./worker-handler.js";

export interface PlanRunWorkerOptions {
  readonly callables: Iterable<readonly [string, Callable]>;
}

export const planRunWorker = ({ callables }: PlanRunWorkerOptions) => ({
  PlanRun: planRunClass(registeredCallables(callables)),
  Postbox,
  Schedule,
  ServiceTokenLedger,
  default: worker,
});
