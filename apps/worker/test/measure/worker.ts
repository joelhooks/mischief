// @effect-diagnostics asyncFunction:off -- the Worker's fetch handler is a Promise API.
import type { Env } from "../../src/plan-run-object.js";
import { PlanRun as Served } from "../../src/plan-run-object.js";
import served from "../../src/worker.js";
import { commits, meterStorage, runStates } from "./meter.js";

export { Postbox } from "../../src/postbox-object.js";

export { Schedule } from "../../src/schedule-object.js";

export { ServiceTokenLedger } from "../../src/service-tokens.js";

const MEASURE_PATH = "/__measure";

const metered = (ctx: DurableObjectState) =>
  Object.defineProperty(ctx, "storage", { value: meterStorage(ctx.storage) });

export class PlanRun extends Served {
  constructor(ctx: DurableObjectState, env: Env) {
    super(metered(ctx), env);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname !== MEASURE_PATH) {
      return await served.fetch(request, env);
    }

    const taken = { commits: [...commits], runStates: [...runStates] };

    commits.length = 0;
    runStates.length = 0;

    return Response.json(taken);
  },
} satisfies ExportedHandler<Env>;
