import { Clock, Effect } from "effect";

import { CALLER_RETRY_MS } from "./caller-thinks.js";
import type { callerThinkLedger, ShareNotice } from "./caller-thinks.js";

export const callerThinkHost = (ports: {
  readonly ledger: ReturnType<typeof callerThinkLedger>;
  readonly arm: (at: number) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
  readonly send: (
    notice: typeof ShareNotice.Type
  ) => Effect.Effect<void, string>;
  readonly share: number;
  readonly ttlMs: number;
}) => ({
  acquire: Effect.fn("callerThinkHost.acquire")(
    function* acquireCallerThink(input: {
      readonly caller: string;
      readonly id: string;
      readonly objectName: string;
      readonly key: string;
      readonly to: readonly string[];
    }) {
      const now = yield* Clock.currentTimeMillis;
      yield* ports.arm(now + CALLER_RETRY_MS);

      return {
        ...ports.ledger.acquire({
          ...input,
          now,
          share: ports.share,
          ttlMs: ports.ttlMs,
        }),
        share: ports.share,
      };
    }
  ),
  alarm: Effect.fn("callerThinkHost.alarm")(function* deliverCallerNotice() {
    const now = yield* Clock.currentTimeMillis;
    yield* ports.arm(now + CALLER_RETRY_MS);
    const notice = ports.ledger.pending();

    if (notice !== undefined) {
      yield* ports.send(notice);
      ports.ledger.sent(notice.serial, notice.to);
    }

    if (ports.ledger.pending() === undefined) {
      yield* ports.clear;
    }
  }),
});
