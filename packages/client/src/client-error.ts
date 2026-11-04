import { Schema } from "effect";

export class ClientError extends Schema.TaggedError<ClientError>()(
  "ClientError",
  {
    kind: Schema.Literals([
      "configuration",
      "identity",
      "input",
      "transport",
      "protocol",
      "refused",
    ]),
    operation: Schema.String,
    reason: Schema.String,
    response: Schema.optionalKey(Schema.Json),
    status: Schema.optionalKey(Schema.Int),
  }
) {}
