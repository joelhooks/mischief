// @effect-diagnostics asyncFunction:off -- the fixture forwards requests to production Durable Objects.
import type { Env } from "../../src/plan-run-object.js";
import { PlanRun as ProductionPlanRun } from "../../src/plan-run-object.js";
import handler from "../../src/worker-handler.js";

export { Postbox } from "./abort-postbox.js";

export { Schedule } from "./abort-schedule.js";

export { ServiceTokenLedger } from "../../src/service-tokens.js";

export class PlanRun extends ProductionPlanRun {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, MISCHIEF_IDENTITY: "fixture" });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;

    if (path === "/test/notices" || path === "/test/reply") {
      return await env.POSTBOX.get(
        env.POSTBOX.idFromName("mischief/worker")
      ).fetch(request);
    }

    if (path === "/test/timeout") {
      const name = request.headers.get("x-test-schedule");

      if (name === null) {
        return new Response("name required", { status: 400 });
      }

      return await env.SCHEDULE.get(env.SCHEDULE.idFromName(name)).fetch(
        request
      );
    }

    return await handler.fetch(request, env);
  },
};
