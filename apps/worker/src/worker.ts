import { planRunWorker } from "./plan-run-worker.js";

export { DeskWaker } from "./desk-waker-object.js";

const worker = planRunWorker({ callables: new Map() });

export const {
  PlanRun,
  Postbox,
  Schedule,
  ServiceTokenLedger,
  CallerThinks,
  Peon,
  PeonTemplates,
  WatchObject,
} = worker;

export default worker.default;
