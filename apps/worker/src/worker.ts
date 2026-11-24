import { planRunWorker } from "./plan-run-worker.js";

export { DeskWaker } from "./desk-waker-object.js";

export { WatchObject } from "./watch-object.js";

const worker = planRunWorker({ callables: new Map() });

export const {
  PlanRun,
  Postbox,
  Schedule,
  ServiceTokenLedger,
  CallerThinks,
  Peon,
  PeonTemplates,
} = worker;

export default worker.default;
