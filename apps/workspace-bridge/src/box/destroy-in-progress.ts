import { Schema } from "effect";

export class DestroyInProgress extends Schema.TaggedError<DestroyInProgress>()(
  "DestroyInProgress",
  {
    requestId: Schema.String,
    disposition: Schema.String,
    retained: Schema.Boolean,
    message: Schema.String,
    status: Schema.Literal(409),
  }
) {}
