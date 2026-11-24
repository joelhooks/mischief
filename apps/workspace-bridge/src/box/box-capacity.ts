import { Schema } from "effect";

export class BoxCapacity extends Schema.TaggedError<
  BoxCapacity,
  { readonly brand: unique symbol }
>()("BoxCapacity", {
  message: Schema.String,
  state: Schema.Literals(["spawned", "suspended", "hibernated"]),
  status: Schema.Literal(429),
}) {}
