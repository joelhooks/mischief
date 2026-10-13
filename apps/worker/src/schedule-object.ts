// @effect-diagnostics asyncFunction:off -- a Durable Object's fetch, alarm and stub calls are Promise APIs.
import { PlanRefused, RunReportSchema, UnknownRun } from "@mischief/core";
import type { WakeRuns } from "@mischief/core";
import { makeSchedule } from "@mischief/plan-run";
import type { ScheduleObject } from "@mischief/plan-run";
import { DurableObject } from "cloudflare:workers";
import { Effect, Option, Schema } from "effect";

import type { Env } from "./plan-run-object.js";
import { OBJECT_HEADER, objectOf, rememberObject } from "./postbox-mail.js";

export const SUBMIT_WAIT_MS = 5000;

const ownerOf = (objectName: string) =>
  objectName.slice(0, objectName.lastIndexOf("/"));

const decodeReport = Schema.decodeUnknownOption(RunReportSchema);

const decodeRefused = Schema.decodeUnknownOption(PlanRefused);

const decodeUnknown = Schema.decodeUnknownOption(UnknownRun);

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const bodyOf = async (response: Response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const wakeRuns = (
  env: Env,
  storage: DurableObjectStorage,
  keepAlive: (pending: Promise<unknown>) => void
): WakeRuns["Service"] => {
  const ownerFor = Effect.suspend(() =>
    Option.match(objectOf(storage), {
      onNone: () =>
        Effect.die(
          "this schedule never learned its owner's DID; create it again through the Mischief worker"
        ),
      onSome: (name) => Effect.succeed(ownerOf(name)),
    })
  );

  const call = async (
    owner: string,
    runId: string,
    capability: string,
    body: Schema.Json
  ): Promise<Answer> => {
    const response = await env.PLAN_RUN.get(
      env.PLAN_RUN.idFromName(`${owner}/${runId}`)
    ).fetch(
      new Request(`https://mischief.internal/${capability}`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          [OBJECT_HEADER]: `${owner}/${runId}`,
        },
        method: "POST",
      })
    );

    return { body: await bodyOf(response), status: response.status };
  };

  return {
    abort: (runId) =>
      ownerFor.pipe(
        Effect.flatMap((owner) =>
          Effect.promise(
            async () => await call(owner, runId, "abortRun", { runId })
          )
        ),
        Effect.flatMap(({ body, status }) =>
          status === 200 || Option.isSome(decodeUnknown(body))
            ? Effect.void
            : Effect.die(`abortRun ${runId} answered ${String(status)}`)
        )
      ),
    inspect: (runId) =>
      ownerFor.pipe(
        Effect.flatMap((owner) =>
          Effect.promise(
            async () => await call(owner, runId, "inspectRun", { runId })
          )
        ),
        Effect.flatMap(({ body, status }) => {
          if (status === 200) {
            return Option.match(decodeReport(body), {
              onNone: () =>
                Effect.die(
                  `inspectRun ${runId} answered 200 with no run report`
                ),
              onSome: (report) => Effect.succeed(Option.some(report)),
            });
          }

          return Option.isSome(decodeUnknown(body))
            ? Effect.succeedNone
            : Effect.die(`inspectRun ${runId} answered ${String(status)}`);
        })
      ),
    submit: (runId, plan, docs, judge) =>
      ownerFor.pipe(
        Effect.flatMap((owner) => {
          const input =
            judge === null
              ? { docs, plan, runId }
              : { docs, judge, plan, runId };

          const pending = call(owner, runId, "submitPlan", input);

          keepAlive(pending);

          return Effect.promise(async () => await pending).pipe(
            Effect.timeoutOption(SUBMIT_WAIT_MS)
          );
        }),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: ({ body, status }) => {
              if (status === 200) {
                return Effect.void;
              }

              return Option.match(decodeRefused(body), {
                onNone: () =>
                  Effect.die(`submitPlan ${runId} answered ${String(status)}`),
                onSome: Effect.fail,
              });
            },
          })
        )
      ),
  };
};

export class Schedule extends DurableObject<Env> {
  private readonly object: ScheduleObject;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

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
      runs: wakeRuns(env, ctx.storage, (pending) => {
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
