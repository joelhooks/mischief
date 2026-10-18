import { Schema } from "effect";

export class DriveLeaseLost extends Schema.TaggedError<DriveLeaseLost>()(
  "DriveLeaseLost",
  {
    owner: Schema.String,
    reason: Schema.String,
  }
) {}
