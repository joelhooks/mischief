import { Schema } from "effect";

export class CustodyMissing extends Schema.TaggedError<CustodyMissing>()(
  "CustodyMissing",
  {
    dir: Schema.String,
    message: Schema.String,
    status: Schema.Literal(503),
  }
) {}

export const custodyMissing = (dir: string, message: string) =>
  new CustodyMissing({ dir, message, status: 503 });
