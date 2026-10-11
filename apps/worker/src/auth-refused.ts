import { Schema } from "effect";

export class AuthRefused extends Schema.TaggedError<AuthRefused>()(
  "AuthRefused",
  { reason: Schema.String }
) {}
