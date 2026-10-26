// @effect-diagnostics asyncFunction:off -- the fixture changes only the stored wake time and invokes the production schedule alarm.
import { scheduleStoreSql } from "@mischief/plan-run";
import { Clock, Effect } from "effect";

import { Schedule as ProductionSchedule } from "../../src/schedule-object.js";

export class Schedule extends ProductionSchedule {
  override async fetch(request: Request) {
    if (new URL(request.url).pathname !== "/test/timeout") {
      return await super.fetch(request);
    }

    await Effect.runPromise(
      Effect.gen({ self: this }, function* elapsed() {
        const store = scheduleStoreSql(this.ctx.storage);

        const state = yield* store.load.pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.orDie
        );

        const now = yield* Clock.currentTimeMillis;
        yield* store.save({
          ...state,
          nextAt: now - 1,
          wakes: state.wakes.map((wake) => ({
            ...wake,
            at: now - 120_000,
          })),
        });
      })
    );
    await super.alarm();

    return Response.json({ ok: true });
  }
}
