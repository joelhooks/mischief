import { Schema } from "effect";

export class ThinkTelemetryUnavailable extends Schema.TaggedError<ThinkTelemetryUnavailable>()(
  "ThinkTelemetryUnavailable",
  { reason: Schema.String }
) {
  override get message() {
    return this.reason;
  }
}
