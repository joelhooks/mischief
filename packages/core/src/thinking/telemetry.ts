import { Context, Effect, Layer } from "effect";

import type { ThinkStatusSchema } from "./contracts.js";
import { ThinkTelemetryUnavailable } from "./telemetry-unavailable.js";

export class ThinkTelemetry extends Context.Service<
  ThinkTelemetry,
  {
    readonly read: Effect.Effect<
      typeof ThinkStatusSchema.Type,
      ThinkTelemetryUnavailable
    >;
  }
>()("@mischief/core/ThinkTelemetry") {
  static readonly unavailable = Layer.succeed(
    ThinkTelemetry,
    ThinkTelemetry.of({
      read: Effect.fail(
        new ThinkTelemetryUnavailable({
          reason:
            "This local CLI has no host Postbox telemetry. Call authenticated POST /thinkStatus with {} on the Mischief host to read its UTC day tally.",
        })
      ),
    })
  );
}
