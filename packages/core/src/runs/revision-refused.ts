import { Schema } from "effect";

export class RevisionRefused extends Schema.TaggedError<RevisionRefused>()(
  "RevisionRefused",
  { reason: Schema.String, runId: Schema.String }
) {
  override get message() {
    return `Revising run ${this.runId} refused, nothing changed: ${this.reason}`;
  }
}
