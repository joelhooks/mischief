import { Context, Effect, Layer, Random, Schema } from "effect";

import type { Held } from "./schema.js";

export const ProviderResumeSchema = Schema.Struct({
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  baseMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  capMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export const ProviderResume = Context.Reference<
  typeof ProviderResumeSchema.Type
>("@mischief/core/ProviderResume", {
  defaultValue: () => ({ attempts: 6, baseMs: 30_000, capMs: 900_000 }),
});

const setting = (text: string | undefined, fallback: number) =>
  text === undefined || text.trim() === "" ? fallback : Number(text);

export const providerResumeLayer = (settings: {
  readonly attempts: string | undefined;
  readonly baseMs: string | undefined;
  readonly capMs: string | undefined;
}) =>
  Layer.effect(
    ProviderResume,
    Schema.decodeEffect(ProviderResumeSchema)({
      attempts: setting(settings.attempts, 6),
      baseMs: setting(settings.baseMs, 30_000),
      capMs: setting(settings.capMs, 900_000),
    }).pipe(Effect.orDie)
  );

export const overloadHeld = ({
  cause,
  status,
}: Pick<Held, "cause" | "status">) =>
  cause !== "billing" &&
  status !== null &&
  (status === 408 || status === 429 || (status >= 500 && status < 600));

export const resumeAfter = (held: Held, attempts: number) =>
  Effect.gen(function* scheduleResume() {
    const policy = yield* ProviderResume;

    if (!overloadHeld(held) || attempts >= policy.attempts) {
      return null;
    }

    const window = Math.min(policy.capMs, policy.baseMs * 2 ** attempts);
    const jitter = Math.floor((yield* Random.next) * window);

    return Math.max(held.since, held.retryAfter ?? held.since) + jitter;
  });

export const providerWakeAt = (held: readonly Held[]) => {
  const times = held.flatMap((entry) =>
    overloadHeld(entry) && entry.resumeAfter !== null ? [entry.resumeAfter] : []
  );

  return times.length === 0 ? null : Math.min(...times);
};
