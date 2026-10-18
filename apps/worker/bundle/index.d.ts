import type { DurableObject } from "cloudflare:workers";

import type { Callable } from "./types/call-registry.js";

export { callable } from "./types/call-registry.js";

export type { Callable, CallSpec } from "./types/call-registry.js";

export { StepFailed } from "./types/step-failed.js";

export type { StepCall } from "./types/step-failed.js";

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
