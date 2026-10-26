import { Cause, Option, Schema } from "effect";

import { PostboxFailed } from "./postbox-failed.js";

export class PostboxReaderFailed extends Schema.TaggedError<PostboxReaderFailed>()(
  "PostboxReaderFailed",
  {
    kind: Schema.Literals(["DatabaseMissing", "Unavailable"]),
    reason: Schema.String,
  }
) {
  static fromCause<E>(cause: Cause.Cause<E>) {
    const reason = Option.match(Cause.findErrorOption(cause), {
      onNone: () => Cause.pretty(cause),
      onSome: (error) =>
        Schema.is(PostboxFailed)(error) ? error.reason : Cause.pretty(cause),
    });

    return new PostboxReaderFailed({
      kind: reason.includes("no db for Postbox:")
        ? "DatabaseMissing"
        : "Unavailable",
      reason,
    });
  }
}
