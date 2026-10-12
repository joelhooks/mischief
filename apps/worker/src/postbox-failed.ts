import { Schema } from "effect";

export class PostboxFailed extends Schema.TaggedError<PostboxFailed>()(
  "PostboxFailed",
  { reason: Schema.String }
) {}
