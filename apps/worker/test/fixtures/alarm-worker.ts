// @effect-diagnostics asyncFunction:off -- the fixture implements Durable Object fetch and alarm Promise APIs.
import { Judge, Operator, Thinker } from "@mischief/core";
import { mailOutboxSql, makePlanRun } from "@mischief/plan-run";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer } from "effect";

import type { Env } from "../../src/plan-run-object.js";

export { Postbox } from "../../src/postbox-object.js";

export { Schedule } from "../../src/schedule-object.js";

export { ServiceTokenLedger } from "../../src/service-tokens.js";

export class PlanRun extends DurableObject<Env> {
  private readonly run;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.run = makePlanRun({
      alarms: {
        clear: async () => {
          await ctx.storage.deleteAlarm();
        },
        get: async () => await ctx.storage.getAlarm(),
        set: async (at) => {
          await ctx.storage.setAlarm(at);
        },
      },
      guardMs: 1000,
      services: Layer.mergeAll(
        Layer.succeed(
          Thinker,
          Thinker.of({
            decide: () => Effect.die("unused"),
            elaborate: () => Effect.die("unused"),
            think: ({ prompt }) =>
              Effect.sleep("2 seconds").pipe(
                Effect.as({ output: `${prompt} finished`, tokens: 2 })
              ),
          })
        ),
        Judge.unwired,
        mailOutboxSql(ctx.storage),
        Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
      ),
      storage: ctx.storage,
    });
  }

  override async fetch(request: Request) {
    return await this.run.fetch(request);
  }

  override async alarm() {
    await this.run.alarm();
  }
}

export { default } from "../../src/worker-handler.js";
