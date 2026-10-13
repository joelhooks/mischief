// @effect-diagnostics asyncFunction:off -- a Durable Object's fetch and alarm handlers are Promise APIs.
import type { Storage } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { JudgeModeSchema, Operator, StepFailed, Thinker } from "@mischief/core";
import { makePlanRun, mailOutboxSql } from "@mischief/plan-run";
import type { PlanRun as Runtime } from "@mischief/plan-run";
import { fauxThinkerOptions, jevJudge, piThinker } from "@mischief/thinking";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  escalate,
  escalationText,
  fixEscalationAtFirstSubmit,
  heldText,
} from "./escalation.js";
import { fixJudgeAtFirstSubmit, judgeChosenPerCall } from "./judge-choice.js";
import {
  OBJECT_HEADER,
  objectOf,
  postboxMail,
  rememberObject,
} from "./postbox-mail.js";
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

const decodeHostJudge = Schema.decodeUnknownOption(JudgeModeSchema);

const judgeFor = (env: Env, storage: DurableObjectStorage) => {
  const key = env.MISCHIEF_JEV_KEY ?? "";

  return judgeChosenPerCall({
    fallback: Option.getOrNull(decodeHostJudge(env.MISCHIEF_JUDGE)),
    jev:
      key === ""
        ? Option.none()
        : Option.some(
            jevJudge({ apiKey: Redacted.make(key) }).pipe(
              Layer.provide(FetchHttpClient.layer)
            )
          ),
    storage,
  });
};

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

    const postbox = () => env.POSTBOX.get(env.POSTBOX.idFromName(POSTBOX_NAME));

    const mailEscalation =
      env.MISCHIEF_IDENTITY === undefined || env.MISCHIEF_IDENTITY === ""
        ? () => Effect.void
        : escalate({
            objectName: () => objectOf(ctx.storage),
            postbox,
            storage: ctx.storage,
          });

    const operator = Layer.succeed(
      Operator,
      Operator.of({
        held: (runId, held, notice) =>
          Effect.logWarning(
            `${runId} is held at ${held.key}: ${held.provider} ${held.cause}`
          ).pipe(
            Effect.andThen(mailEscalation(runId, notice, heldText(runId, held)))
          ),
        notify: (runId, question, notice) =>
          Effect.logInfo(
            `${runId} waits on ${question.key}: ${question.question}`
          ).pipe(
            Effect.andThen(
              mailEscalation(runId, notice, escalationText(runId, question))
            )
          ),
      })
    );

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
        judgeFor(env, ctx.storage),
        env.MISCHIEF_IDENTITY === undefined || env.MISCHIEF_IDENTITY === ""
          ? mailOutboxSql(ctx.storage)
          : postboxMail(ctx.storage, postbox),
        operator
      ),
      storage: ctx.storage,
    });
  }

  override async fetch(request: Request) {
    rememberObject(this.ctx.storage, request.headers.get(OBJECT_HEADER));

    if (new URL(request.url).pathname !== "/submitPlan") {
      return await this.runtime.fetch(request);
    }

    const body = await request.clone().text();
    const forgetJudge = fixJudgeAtFirstSubmit(this.ctx.storage, body);
    const forgetEscalation = fixEscalationAtFirstSubmit(this.ctx.storage, body);

    const response = await this.runtime.fetch(request);

    if (response.status !== 200) {
      forgetJudge();
      forgetEscalation();
    }

    return response;
  }

  override async alarm() {
    await this.runtime.alarm();
  }
}
