// @effect-diagnostics asyncFunction:off -- a Durable Object's fetch and alarm handlers are Promise APIs.
import type { Storage } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  CallRegistry,
  EnabledStepKinds,
  JudgeModeSchema,
  Operator,
  StepFailed,
  Thinker,
  callConcurrencyLayer,
  providerResumeLayer,
  redriveAttemptsLayer,
  stepKindsFrom,
  thinkConcurrencyLayer,
} from "@mischief/core";
import type { Callable, ThinkReceipt } from "@mischief/core";
import { makePlanRun, mailOutboxSql } from "@mischief/plan-run";
import type { PlanRun as Runtime } from "@mischief/plan-run";
import {
  fauxThinkerOptions,
  gatewayThinkerOptions,
  jevJudge,
  piThinker,
} from "@mischief/thinking";
import { DurableObject } from "cloudflare:workers";
import { Clock, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  escalate,
  escalationText,
  fixEscalationAtFirstSubmit,
  heldText,
  holdAlarmTargets,
  alarmOnHolds,
  mailOnce,
} from "./escalation.js";
import {
  fixJudgeAtFirstSubmit,
  forgetUnlessStored,
  judgeChosenPerCall,
} from "./judge-choice.js";
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
import { utcDay, warnText } from "./think-tally.js";

const TELEMETRY_DESK = "pi-durable/desk";

export interface Env {
  readonly PLAN_RUN: DurableObjectNamespace<PlanRun>;
  readonly SERVICE_TOKENS: DurableObjectNamespace<ServiceTokenLedger>;
  readonly MISCHIEF_DID?: string;
  readonly MISCHIEF_CALLERS?: string;
  readonly MISCHIEF_MODEL: string;
  readonly MISCHIEF_CLIPROXY_URL?: string;
  readonly MISCHIEF_CLIPROXY_KEY?: string;
  readonly MISCHIEF_GUARD_MS: string;
  readonly MISCHIEF_REDRIVE_ATTEMPTS?: string;
  readonly MISCHIEF_RESUME_ATTEMPTS?: string;
  readonly MISCHIEF_RESUME_BASE_MS?: string;
  readonly MISCHIEF_RESUME_CAP_MS?: string;
  readonly MISCHIEF_HOLD_ALARM_TO?: string;
  readonly MISCHIEF_JUDGE?: string;
  readonly MISCHIEF_STEP_KINDS?: string;
  readonly MISCHIEF_THINK_CONCURRENCY?: string;
  readonly MISCHIEF_CALL_CONCURRENCY?: string;
  readonly MISCHIEF_JEV_KEY?: string;
  readonly MISCHIEF_IDENTITY?: string;
  readonly MISCHIEF_MAILBOX_URL?: string;
  readonly MISCHIEF_MAILBOX_DID?: string;
  readonly POSTBOX: DurableObjectNamespace<Postbox>;
  readonly SCHEDULE: DurableObjectNamespace<Schedule>;
}

const decodeHostJudge = Schema.decodeUnknownOption(JudgeModeSchema);

const thinkerFor = (
  env: Env,
  storageFor: Parameters<typeof fauxThinkerOptions>[0]
) => {
  if (env.MISCHIEF_MODEL === "faux") {
    return piThinker(fauxThinkerOptions(storageFor));
  }

  const key = env.MISCHIEF_CLIPROXY_KEY ?? "";
  const baseUrl = env.MISCHIEF_CLIPROXY_URL ?? "";

  return env.MISCHIEF_MODEL === "cliproxy" && key !== "" && baseUrl !== ""
    ? piThinker(
        gatewayThinkerOptions(storageFor, {
          apiKey: Redacted.make(key),
          baseUrl,
        })
      )
    : Thinker.unwired;
};

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

  constructor(
    ctx: DurableObjectState,
    env: Env,
    callables: ReadonlyMap<string, Callable> = new Map()
  ) {
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

    const thinker = thinkerFor(env, storageFor);

    const postbox = () => env.POSTBOX.get(env.POSTBOX.idFromName(POSTBOX_NAME));

    const mailPorts = {
      objectName: () => objectOf(ctx.storage),
      postbox,
      storage: ctx.storage,
    };

    const mailWired =
      env.MISCHIEF_IDENTITY !== undefined && env.MISCHIEF_IDENTITY !== "";

    const mailEscalation = mailWired ? escalate(mailPorts) : () => Effect.void;

    const mailDesk = mailWired ? mailOnce(mailPorts) : () => Effect.void;

    const thought = (runId: string, key: string, receipt: ThinkReceipt) =>
      Effect.gen(function* tallied() {
        const today = utcDay(yield* Clock.currentTimeMillis);

        const totals = yield* Effect.tryPromise(
          async () =>
            await postbox().tallyThink(today, runId, receipt.tokens.total)
        );

        yield* Effect.forEach(
          totals.crossed,
          (crossing) =>
            mailDesk(
              runId,
              TELEMETRY_DESK,
              `think-${crossing}:${crossing === "day" ? today : runId}`,
              warnText(crossing, runId, key, totals, today)
            ),
          { discard: true }
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `${runId} think telemetry for ${key} was not tallied: ${String(cause)}`
          )
        )
      );

    const alarmTargets = holdAlarmTargets(env.MISCHIEF_HOLD_ALARM_TO);

    const operator = Layer.succeed(
      Operator,
      Operator.of({
        held: (runId, held, notice) =>
          Effect.logWarning(
            `${runId} is held at ${held.key}: ${held.provider} ${held.cause}`
          ).pipe(
            Effect.andThen(mailEscalation(runId, notice, heldText(runId, held)))
          ),
        holdAlarm: mailWired
          ? alarmOnHolds(mailPorts, alarmTargets)
          : () => Effect.void,
        notify: (runId, question, notice) =>
          Effect.logInfo(
            `${runId} waits on ${question.key}: ${question.question}`
          ).pipe(
            Effect.andThen(
              mailEscalation(runId, notice, escalationText(runId, question))
            )
          ),
        thought,
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
        operator,
        Layer.succeed(CallRegistry, callables),
        Layer.succeed(EnabledStepKinds, stepKindsFrom(env.MISCHIEF_STEP_KINDS)),
        providerResumeLayer({
          attempts: env.MISCHIEF_RESUME_ATTEMPTS,
          baseMs: env.MISCHIEF_RESUME_BASE_MS,
          capMs: env.MISCHIEF_RESUME_CAP_MS,
        }),
        redriveAttemptsLayer(env.MISCHIEF_REDRIVE_ATTEMPTS),
        thinkConcurrencyLayer(env.MISCHIEF_THINK_CONCURRENCY),
        callConcurrencyLayer(env.MISCHIEF_CALL_CONCURRENCY)
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

    try {
      return await this.runtime.fetch(request);
    } finally {
      forgetUnlessStored(this.ctx.storage, forgetJudge, forgetEscalation);
    }
  }

  override async alarm() {
    await this.runtime.alarm();
  }
}
