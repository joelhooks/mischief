import { Effect, Schema } from "effect";

import { Count } from "../plans/schema.js";
import { DocsSchema, JudgeModeSchema } from "../runs/schema.js";

export const ScheduleId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/u)
);

export const HISTORY = 100;

const Millis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Every = Schema.TaggedStruct("every", { ms: Millis });

export const CronCadence = Schema.TaggedStruct("cron", {
  expression: Schema.String,
});

export const CadenceSchema = Schema.Union([Every, CronCadence]);

export type Cadence = typeof CadenceSchema.Type;

export const WakeSchema = Schema.Struct({
  at: Millis,
  due: Millis,
  n: Count,
  runId: Schema.String,
});

export type Wake = typeof WakeSchema.Type;

export const SkipSchema = Schema.Struct({
  at: Millis,
  due: Millis,
  reason: Schema.String,
});

export type Skip = typeof SkipSchema.Type;

export const AbortSchema = Schema.Struct({
  at: Millis,
  reason: Schema.String,
  runId: Schema.String,
});

export type Abort = typeof AbortSchema.Type;

export const EndReasonSchema = Schema.Literals([
  "completed",
  "done",
  "cap",
  "timeout",
  "failed",
]);

export type EndReason = typeof EndReasonSchema.Type;

export const EndedSchema = Schema.Struct({
  at: Millis,
  detail: Schema.String,
  reason: EndReasonSchema,
});

export type Ended = typeof EndedSchema.Type;

export const ScheduleStateSchema = Schema.Struct({
  abortCount: Count.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  aborting: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  aborts: Schema.Array(AbortSchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  cadence: CadenceSchema,
  carry: Schema.Array(Schema.String),
  createdAt: Millis,
  docs: DocsSchema,
  ended: Schema.NullOr(EndedSchema),
  endsAt: Schema.NullOr(Millis),
  judge: Schema.NullOr(JudgeModeSchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  maxWakes: Schema.NullOr(Count),
  nextAt: Millis,
  pendingDocs: DocsSchema,
  plan: Schema.Json,
  scheduleId: ScheduleId,
  skipCount: Count,
  skips: Schema.Array(SkipSchema),
  wakeCount: Count,
  wakeTimeoutMs: Schema.NullOr(Millis).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  wakes: Schema.Array(WakeSchema),
});

export type ScheduleState = typeof ScheduleStateSchema.Type;

export const ScheduleReportSchema = Schema.Struct({
  abortCount: Count,
  aborts: Schema.Array(AbortSchema),
  cadence: CadenceSchema,
  carry: Schema.Array(Schema.String),
  ended: Schema.NullOr(EndedSchema),
  endsAt: Schema.NullOr(Millis),
  judge: Schema.NullOr(JudgeModeSchema),
  maxWakes: Schema.NullOr(Count),
  nextAt: Schema.NullOr(Millis),
  scheduleId: ScheduleId,
  skipCount: Count,
  skips: Schema.Array(SkipSchema),
  wakeCount: Count,
  wakeTimeoutMs: Schema.NullOr(Millis),
  wakes: Schema.Array(WakeSchema),
});

export type ScheduleReport = typeof ScheduleReportSchema.Type;

export const reportOf = (state: ScheduleState): ScheduleReport => ({
  abortCount: state.abortCount,
  aborts: state.aborts,
  cadence: state.cadence,
  carry: state.carry,
  ended: state.ended,
  endsAt: state.endsAt,
  judge: state.judge,
  maxWakes: state.maxWakes,
  nextAt: state.ended === null ? state.nextAt : null,
  scheduleId: state.scheduleId,
  skipCount: state.skipCount,
  skips: state.skips,
  wakeCount: state.wakeCount,
  wakeTimeoutMs: state.wakeTimeoutMs,
  wakes: state.wakes,
});

export const wakeRunId = (scheduleId: string, n: number) =>
  `${scheduleId}-wake-${n}`;
