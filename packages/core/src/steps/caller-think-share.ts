import { Context, Effect, Schema } from "effect";

import type { ProviderUnavailable } from "./provider-unavailable.js";
import type { StepCall } from "./step-failed.js";

export class ThinkAbortUnconfirmed extends Schema.TaggedError<ThinkAbortUnconfirmed>()(
  "ThinkAbortUnconfirmed",
  {
    key: Schema.String,
    reason: Schema.String,
  }
) {}

export interface CallerThinkPermit {
  readonly release: Effect.Effect<void>;
  readonly durationMs: number;
}

export const CallerThinkShare = Context.Reference<{
  readonly acquire: (
    call: StepCall,
    id: string
  ) => Effect.Effect<CallerThinkPermit, ProviderUnavailable>;
}>("@mischief/core/CallerThinkShare", {
  defaultValue: () => ({
    acquire: () =>
      Effect.succeed({
        durationMs: Number.POSITIVE_INFINITY,
        release: Effect.void,
      }),
  }),
});
