// @effect-diagnostics asyncFunction:off -- a Durable Object's fetch and alarm handlers are Promise APIs.
import type { Storage } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { Judge, Operator, StepFailed, Thinker } from "@mischief/core";
import { makePlanRun, mailOutboxSql } from "@mischief/plan-run";
import type { PlanRun as Runtime } from "@mischief/plan-run";
import { fauxThinkerOptions, piThinker } from "@mischief/thinking";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer } from "effect";

export interface Env {
  readonly PLAN_RUN: DurableObjectNamespace<PlanRun>;
  readonly MISCHIEF_DESK: string;
  readonly MISCHIEF_MODEL: string;
  readonly MISCHIEF_GUARD_MS: string;
  readonly MISCHIEF_TOKEN?: string;
}

const operator = Layer.succeed(
  Operator,
  Operator.of({
    notify: (runId, { key, question }) =>
      Effect.logInfo(`${runId} waits on ${key}: ${question}`),
  })
);

export class PlanRun extends DurableObject<Env> {
  private readonly runtime: Runtime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    let opened: Promise<Storage> | undefined;

    const storageFor = () =>
      Effect.tryPromise({
        catch: (cause) =>
          new StepFailed({
            key: "__thinking",
            reason: `could not open the thinking store in this run's Durable Object: ${String(cause)}. Resume the run; if it fails again, check the object's SQLite storage is enabled`,
          }),
        try: async () => {
          opened ??= openDurableObjectSqliteStorage(ctx.storage);

          return await opened;
        },
      });

    const thinker =
      env.MISCHIEF_MODEL === "faux"
        ? piThinker(fauxThinkerOptions(storageFor))
        : Thinker.unwired;

    this.runtime = makePlanRun({
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
      services: Layer.mergeAll(
        thinker,
        Judge.unwired,
        mailOutboxSql(ctx.storage),
        operator
      ),
      storage: ctx.storage,
    });
  }

  override async fetch(request: Request) {
    return await this.runtime.fetch(request);
  }

  override async alarm() {
    await this.runtime.alarm();
  }
}
