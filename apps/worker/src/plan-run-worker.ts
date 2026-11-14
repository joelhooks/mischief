import type { Callable } from "@mischief/core";

import { CallerThinks } from "./caller-think-object.js";
import { Peon } from "./peon-object.js";
import { PeonTemplates } from "./peon-registry.js";
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
  CallerThinks,
  Peon,
  PeonTemplates,
  PlanRun: planRunClass(registeredCallables(callables)),
  Postbox,
  Schedule,
  ServiceTokenLedger,
  default: worker,
});
