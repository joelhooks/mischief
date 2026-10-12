// @effect-diagnostics asyncFunction:off -- a Durable Object's fetch and alarm handlers are Promise APIs.
import type { Storage } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  Judge,
  Operator,
  shadowJudge,
  StepFailed,
  Thinker,
} from "@mischief/core";
import { makePlanRun, mailOutboxSql } from "@mischief/plan-run";
import type { PlanRun as Runtime } from "@mischief/plan-run";
import { fauxThinkerOptions, jevJudge, piThinker } from "@mischief/thinking";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { OBJECT_HEADER, postboxMail, rememberObject } from "./postbox-mail.js";
import { POSTBOX_NAME } from "./postbox-object.js";
import type { Postbox } from "./postbox-object.js";
import type { Schedule } from "./schedule-object.js";
import type { ServiceTokenLedger } from "./service-tokens.js";

export interface Env {
  readonly PLAN_RUN: DurableObjectNamespace<PlanRun>;
  readonly SERVICE_TOKENS: DurableObjectNamespace<ServiceTokenLedger>;
  readonly MISCHIEF_DID?: string;
  readonly MISCHIEF_CALLERS?: string;
  readonly MISCHIEF_MODEL: string;
  readonly MISCHIEF_GUARD_MS: string;
  readonly MISCHIEF_JUDGE?: string;
  readonly MISCHIEF_JEV_KEY?: string;
  readonly MISCHIEF_IDENTITY?: string;
  readonly MISCHIEF_MAILBOX_URL?: string;
  readonly MISCHIEF_MAILBOX_DID?: string;
  readonly POSTBOX: DurableObjectNamespace<Postbox>;
  readonly SCHEDULE: DurableObjectNamespace<Schedule>;
}

const judgeFor = (env: Env) => {
  const key = env.MISCHIEF_JEV_KEY ?? "";

  if (env.MISCHIEF_JUDGE === "jev" && key !== "") {
    return jevJudge({ apiKey: Redacted.make(key) }).pipe(
      Layer.provide(FetchHttpClient.layer)
    );
  }

  return env.MISCHIEF_JUDGE === "shadow" ? shadowJudge : Judge.unwired;
};

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
        judgeFor(env),
        env.MISCHIEF_IDENTITY === undefined || env.MISCHIEF_IDENTITY === ""
          ? mailOutboxSql(ctx.storage)
          : postboxMail(ctx.storage, () =>
              env.POSTBOX.get(env.POSTBOX.idFromName(POSTBOX_NAME))
            ),
        operator
      ),
      storage: ctx.storage,
    });
  }

  override async fetch(request: Request) {
    rememberObject(this.ctx.storage, request.headers.get(OBJECT_HEADER));

    return await this.runtime.fetch(request);
  }

  override async alarm() {
    await this.runtime.alarm();
  }
}
