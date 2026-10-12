import { Clock, Duration, Effect, Option, Result, Schema } from "effect";

import type { Docs } from "../runs/schema.js";
import { checkSubmission } from "../runs/submission.js";
import { alarmFor, decide, firstSlot, parseCron, previous } from "./decide.js";
import type { Previous } from "./decide.js";
import { ScheduleAlarm } from "./schedule-alarm.js";
import { ScheduleRefused } from "./schedule-refused.js";
import { ScheduleStore } from "./schedule-store.js";
import { CronCadence, Every, reportOf } from "./schema.js";
import type { Cadence, ScheduleState } from "./schema.js";
import { UnknownSchedule } from "./unknown-schedule.js";
import { WakeRuns } from "./wake-runs.js";

export const MIN_EVERY_MS = 60_000;

export interface ScheduleInput {
  readonly scheduleId: string;
  readonly plan: Schema.Json;
  readonly every?: string | undefined;
  readonly cron?: string | undefined;
  readonly maxWakes?: number | undefined;
  readonly timeout?: string | undefined;
  readonly wakeTimeout?: string | undefined;
  readonly carry?: readonly string[] | undefined;
  readonly docs?: Docs | undefined;
}

const decodeDuration = Schema.decodeUnknownOption(Schema.DurationFromString);

const millisOf = (text: string) =>
  decodeDuration(text).pipe(
    Option.filter(Duration.isFinite),
    Option.map(Duration.toMillis)
  );

const cadenceOf = (
  input: ScheduleInput
): Result.Result<Cadence, readonly string[]> => {
  if ((input.every === undefined) === (input.cron === undefined)) {
    return Result.fail([
      'give exactly one of every (a duration such as "30 minutes") or cron (five fields, UTC, such as "0 9 * * 1-5")',
    ]);
  }

  if (input.cron !== undefined) {
    return Result.match(parseCron(input.cron), {
      onFailure: (failure) =>
        Result.fail([
          `cron "${input.cron}" does not parse: ${failure.message}`,
        ]),
      onSuccess: () =>
        Result.succeed(CronCadence.make({ expression: input.cron ?? "" })),
    });
  }

  return Option.match(millisOf(input.every ?? ""), {
    onNone: () =>
      Result.fail([
        `every "${String(input.every)}" is not a duration; write it as "<number> <unit>", such as "30 minutes" or "1 day"`,
      ]),
    onSome: (ms) =>
      ms < MIN_EVERY_MS
        ? Result.fail([
            `every "${String(input.every)}" is shorter than 1 minute; wakes start fresh runs, so pick 1 minute or longer`,
          ])
        : Result.succeed(Every.make({ ms })),
  });
};

const limitsOf = (
  input: ScheduleInput
): Result.Result<number | null, readonly string[]> => {
  if (input.maxWakes === undefined && input.timeout === undefined) {
    return Result.fail([
      'give maxWakes, timeout or both, so the schedule cannot run forever (such as maxWakes: 40 or timeout: "7 days")',
    ]);
  }

  if (input.timeout === undefined) {
    return Result.succeed(null);
  }

  return Option.match(millisOf(input.timeout), {
    onNone: () =>
      Result.fail([
        `timeout "${input.timeout}" is not a finite duration; write it as "<number> <unit>", such as "7 days"`,
      ]),
    onSome: (ms) =>
      ms > 0
        ? Result.succeed(ms)
        : Result.fail([`timeout "${input.timeout}" must be longer than zero`]),
  });
};

const wakeLimitOf = (
  input: ScheduleInput
): Result.Result<number | null, readonly string[]> => {
  if (input.wakeTimeout === undefined) {
    return Result.succeed(null);
  }

  return Option.match(millisOf(input.wakeTimeout), {
    onNone: () =>
      Result.fail([
        `wakeTimeout "${input.wakeTimeout}" is not a finite duration; write it as "<number> <unit>", such as "2 hours"`,
      ]),
    onSome: (ms) =>
      ms < MIN_EVERY_MS
        ? Result.fail([
            `wakeTimeout "${input.wakeTimeout}" is shorter than 1 minute; give each wake at least a minute to finish`,
          ])
        : Result.succeed(ms),
  });
};

const carryErrors = (input: ScheduleInput) => {
  const docs = input.docs ?? {};

  return (input.carry ?? [])
    .filter((name) => !Object.hasOwn(docs, name))
    .map(
      (name) =>
        `carry doc "${name}" has no starting value; add it to docs so the first wake has it too`
    );
};

const refuse = (scheduleId: string, errors: readonly string[]) =>
  new ScheduleRefused({ errors, scheduleId });

const loaded = (scheduleId: string) =>
  ScheduleStore.use((store) => store.load).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new UnknownSchedule({ scheduleId })),
        onSome: Effect.succeed,
      })
    )
  );

export const createSchedule = Effect.fn("createSchedule")(
  function* createSchedule(input: ScheduleInput) {
    const store = yield* ScheduleStore;
    const existing = yield* store.load;

    if (Option.isSome(existing)) {
      return reportOf(existing.value);
    }

    const cadence = cadenceOf(input);
    const limit = limitsOf(input);
    const wakeLimit = wakeLimitOf(input);

    const errors = [
      ...(Result.isFailure(cadence) ? cadence.failure : []),
      ...(Result.isFailure(limit) ? limit.failure : []),
      ...(Result.isFailure(wakeLimit) ? wakeLimit.failure : []),
      ...carryErrors(input),
    ];

    const docs = input.docs ?? {};

    yield* checkSubmission(input.plan, docs).pipe(
      Effect.mapError((refused) =>
        refuse(input.scheduleId, [...errors, ...refused.errors])
      )
    );

    if (
      errors.length > 0 ||
      Result.isFailure(cadence) ||
      Result.isFailure(limit) ||
      Result.isFailure(wakeLimit)
    ) {
      return yield* refuse(input.scheduleId, errors);
    }

    const now = yield* Clock.currentTimeMillis;

    const state: ScheduleState = {
      abortCount: 0,
      aborting: null,
      aborts: [],
      cadence: cadence.success,
      carry: [...(input.carry ?? [])],
      createdAt: now,
      docs,
      ended: null,
      endsAt: limit.success === null ? null : now + limit.success,
      maxWakes: input.maxWakes ?? null,
      nextAt: firstSlot(cadence.success, now),
      pendingDocs: {},
      plan: input.plan,
      scheduleId: input.scheduleId,
      skipCount: 0,
      skips: [],
      wakeCount: 0,
      wakeTimeoutMs: wakeLimit.success,
      wakes: [],
    };

    yield* store.save(state);
    yield* ScheduleAlarm.use((alarm) => alarm.set(alarmFor(state)));

    return reportOf(state);
  }
);

export const inspectSchedule = Effect.fn("inspectSchedule")(
  function* inspectSchedule(scheduleId: string) {
    return reportOf(yield* loaded(scheduleId));
  }
);

export const completeSchedule = Effect.fn("completeSchedule")(
  function* completeSchedule(scheduleId: string) {
    const state = yield* loaded(scheduleId);

    if (state.ended !== null) {
      return reportOf(state);
    }

    const now = yield* Clock.currentTimeMillis;

    const ended: ScheduleState = {
      ...state,
      ended: {
        at: now,
        detail: `completed by its owner after ${String(state.wakeCount)} wakes`,
        reason: "completed",
      },
    };

    yield* ScheduleStore.use((store) => store.save(ended));
    yield* ScheduleAlarm.use((alarm) => alarm.set(null));

    return reportOf(ended);
  }
);

const previousOf = (state: ScheduleState) => {
  const wake = state.wakes.at(-1);

  if (wake === undefined) {
    return Effect.succeed<Previous>(previous.None());
  }

  return WakeRuns.use((runs) => runs.inspect(wake.runId)).pipe(
    Effect.map(
      Option.match({
        onNone: (): Previous => previous.Missing(),
        onSome: (report): Previous => previous.Reported({ report }),
      })
    )
  );
};

export const wakeSchedule = Effect.fn("wakeSchedule")(function* wakeSchedule() {
  const store = yield* ScheduleStore;
  const found = yield* store.load;

  if (Option.isNone(found)) {
    return yield* ScheduleAlarm.use((alarm) => alarm.set(null));
  }

  const now = yield* Clock.currentTimeMillis;
  const seen = yield* previousOf(found.value);
  const decision = decide(found.value, now, seen);

  yield* store.save(decision.state);

  if (decision.abort !== null) {
    const { abort } = decision;

    yield* WakeRuns.use((runs) => runs.abort(abort));
  }

  if (decision.start !== null) {
    const { docs, runId } = decision.start;

    const submitted = yield* WakeRuns.use((runs) =>
      runs.submit(runId, decision.state.plan, docs)
    ).pipe(Effect.result);

    if (Result.isFailure(submitted)) {
      const ended: ScheduleState = {
        ...decision.state,
        ended: {
          at: now,
          detail: `wake ${runId} was refused: ${submitted.failure.errors.join("; ")}. The pinned plan no longer validates on this host; create a new schedule with a fixed plan`,
          reason: "failed",
        },
      };

      yield* store.save(ended);

      return yield* ScheduleAlarm.use((alarm) => alarm.set(null));
    }
  }

  return yield* ScheduleAlarm.use((alarm) => alarm.set(decision.alarmAt));
});
