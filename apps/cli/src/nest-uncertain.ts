import { Schema } from "effect";

export class NestUncertain extends Schema.TaggedError<NestUncertain>()(
  "NestUncertain",
  { stderr: Schema.String }
) {}
