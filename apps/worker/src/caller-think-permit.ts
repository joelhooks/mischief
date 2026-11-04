import { CallerThinkShare, ProviderUnavailable } from "@mischief/core";
import type { StepCall } from "@mischief/core";
import { Effect } from "effect";

export const callerThinkPermit = (ports: {
  readonly acquire: (
    call: StepCall,
    id: string
  ) => Effect.Effect<
    {
      readonly acquired: boolean;
      readonly share: number;
    },
    ProviderUnavailable
  >;
  readonly release: (id: string) => Effect.Effect<void>;
  readonly durationMs: number;
}) =>
  CallerThinkShare.of({
    acquire: Effect.fn("callerThinkPermit.acquire")(
      function* acquireCallerThink(call, id) {
        const result = yield* ports.acquire(call, id);

        if (!result.acquired) {
          return yield* new ProviderUnavailable({
            cause: "busy",
            error: `waiting for caller share: this caller's share of ${result.share} concurrent thinks across runs is full; the run's alarm retries automatically`,
            key: call.key,
            provider: "caller-share",
            status: 429,
          });
        }

        return { durationMs: ports.durationMs, release: ports.release(id) };
      }
    ),
  });
