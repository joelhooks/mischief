// @effect-diagnostics asyncFunction:off -- Fixture RPCs use the Durable Object Promise API.
import { Clock, DateTime, Effect, Schema } from "effect";

import type { Env } from "../../src/plan-run-object.js";
import { WatchCheckpoint } from "../../src/watch-machine.js";
import {
  watchBudgetName,
  WatchObject as ProductionWatch,
} from "../../src/watch-object.js";
import worker from "../../src/worker.js";

export {
  PlanRun,
  CallerThinks,
  Peon,
  PeonTemplates,
  Postbox,
  Schedule,
  ServiceTokenLedger,
} from "../../src/worker.js";

type FixtureEnv = Omit<Env, "WATCH"> & {
  readonly WATCH?: DurableObjectNamespace<WatchObject>;
};

export class WatchObject extends ProductionWatch {
  async fireSoon() {
    await this.ctx.storage.transaction(async (transaction) => {
      const stored = Schema.decodeUnknownSync(WatchCheckpoint)(
        await transaction.get("watch")
      );

      const nextAt = Effect.runSync(Clock.currentTimeMillis);
      await transaction.put(
        "watch",
        Schema.encodeSync(WatchCheckpoint)({ ...stored, nextAt })
      );
      await transaction.setAlarm(nextAt);
    });
  }
}

export default {
  async fetch(request: Request, env: FixtureEnv) {
    const url = new URL(request.url);
    const binding = env.WATCH;
    const watchId = url.searchParams.get("watchId");

    if (binding !== undefined && request.method === "POST") {
      if (url.pathname === "/test/watch-fire" && watchId !== null) {
        await binding.getByName(watchId).fireSoon();

        return Response.json({ scheduled: true });
      }

      if (url.pathname === "/test/watch-budget") {
        const budget = binding.getByName(watchBudgetName("example/desk"));
        const day = DateTime.formatIsoDateUtc(Effect.runSync(DateTime.now));
        await Promise.all(
          Array.from(
            { length: 19 },
            async (_, index) => await budget.reserveWake(day, `prior-${index}`)
          )
        );

        return Response.json({ reserved: 19 });
      }
    }

    return await worker.fetch(request, env);
  },
};
