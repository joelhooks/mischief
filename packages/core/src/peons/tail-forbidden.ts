import { Schema } from "effect";

export class PeonTailForbidden extends Schema.TaggedError<
  PeonTailForbidden,
  { readonly brand: unique symbol }
>()("PeonTailForbidden", { reason: Schema.String }, { httpApiStatus: 403 }) {}
