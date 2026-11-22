import { Schema } from "effect";

export class ReplicaPending extends Schema.TaggedError<
  ReplicaPending,
  { readonly brand: unique symbol }
>()("ReplicaPending", {
  archiveId: Schema.String,
  message: Schema.String,
  status: Schema.Literal(409),
}) {}
