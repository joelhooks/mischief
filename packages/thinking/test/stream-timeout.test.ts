import type { StreamOptions } from "@earendil-works/pi-ai";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  THINK_STREAM_TIMEOUT_MS,
  gatewayStreamOptions,
} from "../dist/index.js";

const CELLD_FETCH_TIMEOUT_MS = 1_500_000;

const SDK_DEFAULT_TIMEOUT_MS = 600_000;

const CallerSchema = Schema.Struct({
  run: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ maximum: 3_600_000, minimum: 1 }))
  ),
});

it.effect.prop(
  "every gateway stream carries a timeout above the SDK's 10 minutes and below celld's fetch timeout unless the caller sets one",
  { caller: Arbitrary.schema(CallerSchema) },
  ({ caller }) =>
    Effect.sync(() => {
      const given: StreamOptions = {};

      if (caller.timeoutMs !== undefined) {
        given.timeoutMs = caller.timeoutMs;
      }

      if (caller.run !== undefined) {
        given.metadata = { mischiefPromptCacheKey: caller.run };
      }

      const options = gatewayStreamOptions(given);

      expect(options.timeoutMs).toBe(
        caller.timeoutMs ?? THINK_STREAM_TIMEOUT_MS
      );
      expect(gatewayStreamOptions().timeoutMs).toBe(THINK_STREAM_TIMEOUT_MS);
      expect(THINK_STREAM_TIMEOUT_MS).toBeGreaterThan(SDK_DEFAULT_TIMEOUT_MS);
      expect(THINK_STREAM_TIMEOUT_MS).toBeLessThan(CELLD_FETCH_TIMEOUT_MS);
    })
);
