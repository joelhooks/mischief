import { PeonState } from "@mischief/core";
import { Schema } from "effect";

export class BoxBuildRefused extends Schema.TaggedError<
  BoxBuildRefused,
  { readonly brand: unique symbol }
>()("BoxBuildRefused", {
  message: Schema.String,
  state: Schema.optionalKey(PeonState),
  status: Schema.Literal(409),
}) {}
