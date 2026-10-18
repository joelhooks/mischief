import type { DurableObject } from "cloudflare:workers";

import type { Callable } from "./dist/types/call-registry.js";

export { callable } from "./dist/types/call-registry.js";

export type { Callable, CallSpec } from "./dist/types/call-registry.js";

export { StepFailed } from "./dist/types/step-failed.js";

export type { StepCall } from "./dist/types/step-failed.js";

export interface PlanRunWorkerOptions {
  readonly callables: Iterable<readonly [string, Callable]>;
}

export declare const planRunWorker: (options: PlanRunWorkerOptions) => {
  readonly PlanRun: typeof DurableObject;
  readonly Postbox: typeof DurableObject;
  readonly Schedule: typeof DurableObject;
  readonly ServiceTokenLedger: typeof DurableObject;
  readonly default: ExportedHandler;
};
