import { Schema } from "effect";

import { SkippedEntry } from "./archive.js";

export class CustodyIncomplete extends Schema.TaggedError<CustodyIncomplete>()(
  "CustodyIncomplete",
  {
    skipped: Schema.Array(SkippedEntry),
    message: Schema.String,
    status: Schema.Literal(409),
  }
) {}
