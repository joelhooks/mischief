import { Schema } from "effect";

export class ReceiptMismatch extends Schema.TaggedError<ReceiptMismatch>()(
  "ReceiptMismatch",
  {
    reason: Schema.String,
    message: Schema.String,
    status: Schema.Literal(409),
  }
) {}
