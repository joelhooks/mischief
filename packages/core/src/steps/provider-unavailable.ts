import { Schema } from "effect";

export const ProviderCauseSchema = Schema.Literals([
  "billing",
  "busy",
  "server",
  "timeout",
]);

export type ProviderCause = typeof ProviderCauseSchema.Type;

export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()(
  "ProviderUnavailable",
  {
    cause: ProviderCauseSchema,
    error: Schema.optionalKey(Schema.String),
    key: Schema.String,
    provider: Schema.String,
    retryAfter: Schema.optional(Schema.Finite),
    status: Schema.NullOr(Schema.Int),
  }
) {}
