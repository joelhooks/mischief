// @effect-diagnostics asyncFunction:off -- a Durable Object's fetch, alarm and stub calls are Promise APIs.
import { submitMailReachReason } from "@mischief/core";
import { makeSchedule } from "@mischief/plan-run";
import type { ScheduleObject } from "@mischief/plan-run";
import { DurableObject } from "cloudflare:workers";
import { Effect, Option } from "effect";

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
      guardMs: Number(env.MISCHIEF_GUARD_MS),
      notices: mailWired
        ? scheduleNotices({
            mailReach: () => env.MISCHIEF_MAIL_REACH,
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

    if (new URL(request.url).pathname === "/createSchedule") {
      const body = await request.clone().text();

      const reason = Option.match(objectOf(this.ctx.storage), {
        onNone: () =>
          "this schedule has no submitting caller identity. Create it through the Worker so mail reach can be checked",
        onSome: (name) =>
          submitMailReachReason(
            name.slice(0, name.lastIndexOf("/")),
            body,
            this.env.MISCHIEF_MAIL_REACH
          ),
      });

      if (reason !== undefined) {
        return Response.json({ error: reason }, { status: 403 });
      }
    }

    return await this.object.fetch(request);
  }

  override async alarm() {
    await this.object.alarm();
  }
}
