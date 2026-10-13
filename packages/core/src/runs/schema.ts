import { Effect, Schema } from "effect";

import { Count, PlanSchema } from "../plans/schema.js";
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
  "failed",
]);

export type RunStatus = typeof RunStatusSchema.Type;

export const terminalStatuses: ReadonlySet<RunStatus> = new Set([
  "done",
  "amendment-refused",
  "aborted",
  "failed",
]);

export const QueuedEventSchema = Schema.StructWithRest(
  Schema.Struct({
    actorId: Schema.optionalKey(Schema.String),
    type: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

export type QueuedEvent = typeof QueuedEventSchema.Type;

export const DirectiveSchema = Schema.TaggedUnion({
  Ask: {
    envelope: Schema.String,
    epoch: Count,
    messageId: Schema.String,
    to: Schema.String,
    visit: Count,
  },
  Emit: { question: QuestionInputSchema },
});

export type Directive = typeof DirectiveSchema.Type;

const DIRECTIVE_KEY =
  /^(?<runId>[a-z0-9][a-z0-9-]{0,63}):(?<step>[a-z_][a-z0-9_-]*(?:\.[a-z_][a-z0-9_-]*)*):(?<visit>[1-9][0-9]*):(?<index>0|[1-9][0-9]*)$/u;

export const DirectiveKey = Schema.String.check(
  Schema.isPattern(DIRECTIVE_KEY)
);

export interface DirectiveAddress {
  readonly index: number;
  readonly runId: string;
  readonly step: string;
  readonly visit: number;
}

export const directiveKey = ({ index, runId, step, visit }: DirectiveAddress) =>
  `${runId}:${step}:${visit}:${index}`;

export const directiveAddress = (key: string): DirectiveAddress | undefined => {
  const groups = DIRECTIVE_KEY.exec(key)?.groups;

  return groups === undefined
    ? undefined
    : {
        index: Number(groups.index),
        runId: groups.runId ?? "",
        step: groups.step ?? "",
        visit: Number(groups.visit),
      };
};

export const PendingDirectiveSchema = Schema.Struct({
  directive: DirectiveSchema,
  key: DirectiveKey,
});

export type PendingDirective = typeof PendingDirectiveSchema.Type;

export const CheckpointSchema = Schema.Struct({
  mailbox: Schema.Array(QueuedEventSchema),
  pending: Schema.Array(PendingDirectiveSchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  snapshot: Schema.Unknown,
  starts: Schema.Record(Schema.String, Count),
  transitionIndex: Count,
});

export type Checkpoint = typeof CheckpointSchema.Type;

export const DocsSchema = Schema.Record(Schema.String, Schema.Json);

export type Docs = typeof DocsSchema.Type;

export const JudgeModeSchema = Schema.Literals(["shadow", "jev"]).annotate({
  description:
    'Who answers this run\'s judge steps: "shadow" records each question for a relay to answer, "jev" asks Jev. Omitted, the host default answers. Fixed at the first submit',
});

export type JudgeMode = typeof JudgeModeSchema.Type;

export const EscalateToSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}(?:\/[a-z][a-z0-9_-]{0,63})?$/u)
).annotate({
  description:
    'The Rat King name that gets mail when a judge escalates, such as "agent-graph/desk". Omitted, an escalation only waits for answerRun. Fixed at the first submit',
});

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
  runId: Schema.optionalKey(RunId),
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
  revision: Schema.NullOr(
    Schema.Struct({ diverged: Schema.Boolean, from: Count })
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
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

export const FailureSchema = Schema.Struct({
  key: Schema.String,
  reason: Schema.String,
});

export const RunReportSchema = Schema.Struct({
  awaiting: Schema.optionalKey(Schema.Array(AwaitingSchema)),
  docs: DocsSchema,
  failures: Schema.optionalKey(Schema.Array(FailureSchema)),
  planId: Schema.String,
  planVersion: Count,
  question: Schema.optionalKey(QuestionSchema),
  runId: RunId,
  status: RunStatusSchema,
  transitions: Count,
  value: Schema.NullOr(Schema.String),
});

export type RunReport = typeof RunReportSchema.Type;

export const RevisionReportSchema = Schema.Struct({
  dryRun: Schema.Boolean,
  live: Schema.Array(Schema.String),
  reused: Schema.Array(Schema.String),
  run: RunReportSchema,
});

export type RevisionReport = typeof RevisionReportSchema.Type;

export const JournalLineSchema = Schema.Struct({
  entry: Schema.Json,
  key: Schema.String,
});

export const RunRecordSchema = Schema.Struct({
  journal: Schema.Array(JournalLineSchema),
  plan: PlanSchema,
  planVersion: Count,
  runId: RunId,
});

export type RunRecord = typeof RunRecordSchema.Type;
