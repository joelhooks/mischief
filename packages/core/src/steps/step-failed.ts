import { Schema } from "effect";

export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  key: Schema.String,
  reason: Schema.String,
}) {}

export interface StepCall {
  readonly key: string;
  readonly runId: string;
  readonly visit: number;
}
