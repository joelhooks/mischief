import { Effect, Schema } from "effect";

import { Count } from "../plans/schema.js";
import { QuestionInputSchema } from "../steps/inputs.js";

export const RunId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u)
);

export const RunStatusSchema = Schema.Literals([
  "running",
  "paused",
  "waiting-for-joel",
  "waiting-for-reply",
  "done",
  "envelope-exceeded",
  "amendment-refused",
  "aborted",
  "stuck",
]);

export type RunStatus = typeof RunStatusSchema.Type;

export const terminalStatuses: ReadonlySet<RunStatus> = new Set([
  "done",
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

export const AwaitingSchema = Schema.Struct({
  key: Schema.String,
  messageId: Schema.String,
  to: Schema.String,
  writes: Schema.NullOr(Schema.String),
});

export type Awaiting = typeof AwaitingSchema.Type;

export const ReplyLineSchema = Schema.Struct({
  acceptedAt: Schema.optionalKey(Schema.String),
  body: Schema.String,
  from: Schema.optionalKey(Schema.String),
  messageId: Schema.optionalKey(Schema.String),
  replyTo: Schema.String,
});

export type ReplyLine = typeof ReplyLineSchema.Type;

export const PendingReplySchema = Schema.Struct({
  body: Schema.String,
  key: Schema.String,
});

export type PendingReply = typeof PendingReplySchema.Type;

export const RunStateSchema = Schema.Struct({
  answers: Schema.Record(Schema.String, Count),
  asking: Schema.NullOr(QuestionInputSchema),
  awaiting: Schema.Array(AwaitingSchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  capped: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  checkpoint: Schema.NullOr(CheckpointSchema),
  planVersion: Count,
  replies: Schema.Array(PendingReplySchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  seeded: Schema.NullOr(Schema.Array(Schema.String)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
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
  awaiting: Schema.optionalKey(Schema.Array(AwaitingSchema)),
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
