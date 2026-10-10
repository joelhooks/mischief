import { Schema } from "effect";

export class AnswerRefused extends Schema.TaggedError<AnswerRefused>()(
  "AnswerRefused",
  { reason: Schema.String, runId: Schema.String }
) {}
