import { Schema } from "effect";

export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  key: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Step ${this.key} failed: ${this.reason}. The run recorded failed:${this.key} in its docs; inspectRun shows where it went next.`;
  }
}

export interface StepCall {
  readonly key: string;
  readonly runId: string;
  readonly visit: number;
}
