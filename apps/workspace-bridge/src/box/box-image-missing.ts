import { Schema } from "effect";

export class BoxImageMissing extends Schema.TaggedError<
  BoxImageMissing,
  { readonly brand: unique symbol }
>()("BoxImageMissing", {
  message: Schema.String,
  state: Schema.Literal("spawned"),
  status: Schema.Literal(503),
}) {}
