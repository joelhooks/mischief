import { Schema } from "effect";

export class BridgeFailure extends Schema.TaggedError<BridgeFailure>()(
  "BridgeFailure",
  {
    message: Schema.String,
    retryAfter: Schema.optionalKey(Schema.Int),
    status: Schema.Literals([400, 401, 403, 404, 413, 429, 500, 502, 503, 504]),
  }
) {}
