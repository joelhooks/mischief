import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";

import { retryAfterOf } from "../src/provider-status.js";

const Seconds = Schema.Int.check(
  Schema.isBetween({ maximum: 7200, minimum: 0 })
);

it.effect.prop(
  "recoverable cooldown bodies and Retry-After text keep the later deadline, including date headers, with no hint cap",
  {
    cooldown: Seconds,
    date: Schema.Boolean,
    flat: Schema.Boolean,
    header: Seconds,
  },
  ({ cooldown, date, flat, header }) =>
    Effect.sync(() => {
      const now = 1_700_000_000_000;
      const error = { code: "model_cooldown", reset_seconds: cooldown };
      const body = JSON.stringify(flat ? error : { error });

      const value = date
        ? DateTime.toDateUtc(
            DateTime.makeUnsafe(now + header * 1000)
          ).toUTCString()
        : String(header);

      const text = `Proxy API error (429): ${body}\nRetry-After: ${value}`;

      expect(retryAfterOf(text, 429, now)).toBe(
        now + Math.max(cooldown, header) * 1000
      );
      expect(retryAfterOf(text, 503, now)).toBe(now + header * 1000);
      expect(retryAfterOf(body, 429, now)).toBe(now + cooldown * 1000);
      expect(retryAfterOf(body, 503, now)).toBeUndefined();
      expect(
        retryAfterOf(
          '429 {"error":{"code":"billing","reset_seconds":999}}',
          429,
          now
        )
      ).toBeUndefined();
      expect(
        retryAfterOf(
          '429 {"error":{"code":"model_cooldown","reset_seconds":-1}}',
          429,
          now
        )
      ).toBeUndefined();
      expect(retryAfterOf("503 overloaded", 503, now)).toBeUndefined();
    }),
  { arbitrary: { runs: 100 } }
);
