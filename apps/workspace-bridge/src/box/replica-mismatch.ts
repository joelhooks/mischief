import { Schema } from "effect";

export class ReplicaMismatch extends Schema.TaggedError<
  ReplicaMismatch,
  { readonly brand: unique symbol }
>()("ReplicaMismatch", {
  archiveId: Schema.String,
  message: Schema.String,
  status: Schema.Literal(409),
}) {}
