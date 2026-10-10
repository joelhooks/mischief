import { Schema } from "effect";

import { Count } from "../plans/schema.js";
import { QuestionInputSchema } from "../steps/inputs.js";

export const RunId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u)
);

export const RunStatusSchema = Schema.Literals([
  "running",
  "paused",
  "waiting-for-joel",
  "done",
  "envelope-exceeded",
  "amendment-refused",
  "aborted",
  "stuck",
]);

export type RunStatus = typeof RunStatusSchema.Type;

export const terminalStatuses: ReadonlySet<RunStatus> = new Set([
  "done",
  "envelope-exceeded",
  "amendment-refused",
  "aborted",
]);

export const QueuedEventSchema = Schema.StructWithRest(
  Schema.Struct({
    actorId: Schema.optionalKey(Schema.String),
    type: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

export type QueuedEvent = typeof QueuedEventSchema.Type;

export const CheckpointSchema = Schema.Struct({
  mailbox: Schema.Array(QueuedEventSchema),
  snapshot: Schema.Unknown,
  starts: Schema.Record(Schema.String, Count),
  transitionIndex: Count,
});

export type Checkpoint = typeof CheckpointSchema.Type;

export const DocsSchema = Schema.Record(Schema.String, Schema.Json);

export type Docs = typeof DocsSchema.Type;

export const RunStateSchema = Schema.Struct({
  answers: Schema.Record(Schema.String, Count),
  asking: Schema.NullOr(QuestionInputSchema),
  checkpoint: Schema.NullOr(CheckpointSchema),
  planVersion: Count,
  status: RunStatusSchema,
  transitions: Count,
  value: Schema.NullOr(Schema.String),
});

export type RunState = typeof RunStateSchema.Type;

export const QuestionSchema = Schema.Struct({
  ...QuestionInputSchema.fields,
  answered: Count,
});

export type Question = typeof QuestionSchema.Type;

export const RunReportSchema = Schema.Struct({
  docs: DocsSchema,
  planId: Schema.String,
  planVersion: Count,
  question: Schema.optionalKey(QuestionSchema),
  runId: RunId,
  status: RunStatusSchema,
  transitions: Count,
  value: Schema.NullOr(Schema.String),
});

export type RunReport = typeof RunReportSchema.Type;
