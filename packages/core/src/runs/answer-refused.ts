import { Schema } from "effect";

export class AnswerRefused extends Schema.TaggedError<AnswerRefused>()(
  "AnswerRefused",
  { reason: Schema.String, runId: Schema.String }
) {
  override get message() {
    return `Answer refused for run ${this.runId}: ${this.reason}`;
  }
}
