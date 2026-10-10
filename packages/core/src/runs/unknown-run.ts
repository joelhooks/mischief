import { Schema } from "effect";

export class UnknownRun extends Schema.TaggedError<UnknownRun>()("UnknownRun", {
  runId: Schema.String,
}) {
  override get message() {
    return `No run named "${this.runId}". Check the runId, or start one with submitPlan({ runId, plan }).`;
  }
}
