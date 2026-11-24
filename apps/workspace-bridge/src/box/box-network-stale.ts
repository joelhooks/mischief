import { Schema } from "effect";

export class BoxNetworkStale extends Schema.TaggedError<
  BoxNetworkStale,
  { readonly brand: unique symbol }
>()("BoxNetworkStale", {
  message: Schema.String,
  status: Schema.Literal(409),
}) {}
