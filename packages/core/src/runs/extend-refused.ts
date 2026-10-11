import { Schema } from "effect";

export class ExtendRefused extends Schema.TaggedError<ExtendRefused>()(
  "ExtendRefused",
  { reason: Schema.String, runId: Schema.String }
) {
  override get message() {
    return `Extending run ${this.runId} refused: ${this.reason}`;
  }
}
