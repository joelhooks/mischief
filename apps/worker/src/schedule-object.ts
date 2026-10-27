// @effect-diagnostics asyncFunction:off -- a Durable Object's fetch, alarm and stub calls are Promise APIs.
import { makeSchedule } from "@mischief/plan-run";
import type { ScheduleObject } from "@mischief/plan-run";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";

import type { Env } from "./plan-run-object.js";
import { OBJECT_HEADER, objectOf, rememberObject } from "./postbox-mail.js";
import { POSTBOX_NAME } from "./postbox-object.js";
import { scheduleNotices } from "./schedule-notices.js";
import { wakeRuns } from "./wake-runs.js";

export class Schedule extends DurableObject<Env> {
  private readonly object: ScheduleObject;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const mailWired =
      env.MISCHIEF_IDENTITY !== undefined && env.MISCHIEF_IDENTITY !== "";

    this.object = makeSchedule({
      alarms: {
        clear: async () => {
          await ctx.storage.deleteAlarm();
        },
        get: async () => await ctx.storage.getAlarm(),
        set: async (at) => {
          await ctx.storage.setAlarm(at);
        },
      },
      notices: mailWired
        ? scheduleNotices({
            objectName: () => objectOf(ctx.storage),
            postbox: () =>
              env.POSTBOX.get(env.POSTBOX.idFromName(POSTBOX_NAME)),
            storage: ctx.storage,
          })
        : { ended: () => Effect.void },
      runs: wakeRuns(env.PLAN_RUN, ctx.storage, (pending) => {
        ctx.waitUntil(pending);
      }),
      storage: ctx.storage,
    });
  }

  override async fetch(request: Request) {
    rememberObject(this.ctx.storage, request.headers.get(OBJECT_HEADER));

    return await this.object.fetch(request);
  }

  override async alarm() {
    await this.object.alarm();
  }
}
