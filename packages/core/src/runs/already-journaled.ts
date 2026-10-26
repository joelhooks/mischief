import { Schema } from "effect";

export class AlreadyJournaled extends Schema.TaggedError<AlreadyJournaled>()(
  "AlreadyJournaled",
  {
    messageId: Schema.String,
    replyTo: Schema.String,
    runId: Schema.String,
  }
) {
  override get message() {
    return `Run ${this.runId} already stored reply ${this.messageId} to ${this.replyTo}. Record its delivery receipt; do not deliver it again.`;
  }
}
