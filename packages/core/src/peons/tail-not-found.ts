import { Schema } from "effect";

export class PeonTailNotFound extends Schema.TaggedError<
  PeonTailNotFound,
  { readonly brand: unique symbol }
>()("PeonTailNotFound", { reason: Schema.String }, { httpApiStatus: 404 }) {}
