// @effect-diagnostics asyncFunction:off -- Durable Object stub calls are Promise APIs.
import {
  PlanRefused,
  RunReportSchema,
  UnknownRun,
  WakeUnanswered,
} from "@mischief/core";
import type { WakeRuns } from "@mischief/core";
import type { SqlStorage } from "@mischief/plan-run";
import { Effect, Option, Schema } from "effect";

import { OBJECT_HEADER, objectOf } from "./postbox-mail.js";

export const SUBMIT_WAIT_MS = 5000;

const decodeReport = Schema.decodeUnknownOption(RunReportSchema);

const decodeRefused = Schema.decodeUnknownOption(PlanRefused);

const decodeUnknown = Schema.decodeUnknownOption(UnknownRun);

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

export interface RunObjects<Id> {
  readonly idFromName: (name: string) => Id;
  readonly get: (id: Id) => {
    readonly fetch: (request: Request) => Promise<Response>;
  };
}

type Step = WakeUnanswered["step"];

const bodyOf = async (response: Response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const answered = (
  scheduleId: string,
  runId: string,
  step: Step,
  pending: () => Promise<Answer>
) =>
  Effect.tryPromise({
    catch: (cause) =>
      new WakeUnanswered({
        reason: `did not answer: ${String(cause)}`,
        runId,
        scheduleId,
        step,
      }),
    try: pending,
  });

const unanswered = (
  scheduleId: string,
  runId: string,
  step: Step,
  reason: string
) => Effect.fail(new WakeUnanswered({ reason, runId, scheduleId, step }));

export const wakeRuns = <Id>(
  objects: RunObjects<Id>,
  storage: SqlStorage,
  keepAlive: (pending: Promise<unknown>) => void
): WakeRuns["Service"] => {
  const scheduleFor = Effect.suspend(() =>
    Option.match(objectOf(storage), {
      onNone: () =>
        Effect.die(
          "this schedule never learned its owner's DID; create it again through the Mischief worker"
        ),
      onSome: (name) => {
        const owner = name.slice(0, name.lastIndexOf("/"));

        return Effect.succeed({
          owner,
          scheduleId: name.slice(owner.length + 1),
        });
      },
    })
  );

  const call = async (
    owner: string,
    runId: string,
    capability: Step,
    body: Schema.Json
  ): Promise<Answer> => {
    const response = await objects
      .get(objects.idFromName(`${owner}/${runId}`))
      .fetch(
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
    abort: (runId, reason) =>
      scheduleFor.pipe(
        Effect.flatMap(({ owner, scheduleId }) =>
          answered(
            scheduleId,
            runId,
            "abortRun",
            async () =>
              await call(
                owner,
                runId,
                "abortRun",
                reason === undefined ? { runId } : { reason, runId }
              )
          ).pipe(
            Effect.flatMap(({ body, status }) =>
              status === 200 || Option.isSome(decodeUnknown(body))
                ? Effect.void
                : unanswered(
                    scheduleId,
                    runId,
                    "abortRun",
                    `answered ${String(status)}`
                  )
            )
          )
        )
      ),
    inspect: (runId) =>
      scheduleFor.pipe(
        Effect.flatMap(({ owner, scheduleId }) =>
          answered(
            scheduleId,
            runId,
            "inspectRun",
            async () => await call(owner, runId, "inspectRun", { runId })
          ).pipe(
            Effect.flatMap(({ body, status }) => {
              if (status === 200) {
                return Option.match(decodeReport(body), {
                  onNone: () =>
                    unanswered(
                      scheduleId,
                      runId,
                      "inspectRun",
                      "answered 200 with no run report"
                    ),
                  onSome: Effect.succeedSome,
                });
              }

              return Option.isSome(decodeUnknown(body))
                ? Effect.succeedNone
                : unanswered(
                    scheduleId,
                    runId,
                    "inspectRun",
                    `answered ${String(status)}`
                  );
            })
          )
        )
      ),
    submit: (runId, plan, docs, { escalateTo, judge }) =>
      scheduleFor.pipe(
        Effect.flatMap(({ owner, scheduleId }) => {
          const input = Object.fromEntries(
            Object.entries({ docs, escalateTo, judge, plan, runId }).filter(
              ([, value]) => value !== null
            )
          );

          const pending = call(owner, runId, "submitPlan", input);

          keepAlive(pending);

          return answered(
            scheduleId,
            runId,
            "submitPlan",
            async () => await pending
          ).pipe(
            Effect.timeoutOption(SUBMIT_WAIT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: ({
                  body,
                  status,
                }): Effect.Effect<void, PlanRefused | WakeUnanswered> => {
                  if (status === 200) {
                    return Effect.void;
                  }

                  return Option.match(decodeRefused(body), {
                    onNone: () =>
                      unanswered(
                        scheduleId,
                        runId,
                        "submitPlan",
                        `answered ${String(status)}`
                      ),
                    onSome: Effect.fail,
                  });
                },
              })
            )
          );
        })
      ),
  };
};
