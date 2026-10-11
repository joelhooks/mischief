import { Schema } from "effect";

export class ReplyRefused extends Schema.TaggedError<ReplyRefused>()(
  "ReplyRefused",
  { reason: Schema.String, replyTo: Schema.String }
) {
  override get message() {
    return `Reply to ${this.replyTo} refused: ${this.reason}`;
  }
}
