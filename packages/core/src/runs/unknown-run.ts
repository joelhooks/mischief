import { Schema } from "effect";

export class UnknownRun extends Schema.TaggedError<UnknownRun>()("UnknownRun", {
  runId: Schema.String,
}) {}
