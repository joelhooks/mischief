import type { ProviderCause } from "@mischief/core";
import { Option, Schema } from "effect";

export type ProviderVerdict = "fail" | "hold" | "retryThenHold";

const HOLD = new Set([408, 429, 502, 503]);

const RETRY_THEN_HOLD = new Set([500, 507, 520]);

const SERVER_ERROR = 500;

const LEADING_STATUS = /^(?<status>[1-5]\d{2})\b/u;

const PREFIXED_STATUS = /\((?<status>[1-5]\d{2})\):/u;

export const statusOf = (errorMessage: string): number | null => {
  const found =
    LEADING_STATUS.exec(errorMessage.trim())?.groups?.status ??
    PREFIXED_STATUS.exec(errorMessage)?.groups?.status;

  return found === undefined ? null : Number(found);
};

export const verdictOf = (
  status: number | null,
  transient: boolean
): ProviderVerdict => {
  if (status === null) {
    return transient ? "retryThenHold" : "fail";
  }

  if (HOLD.has(status)) {
    return "hold";
  }

  return RETRY_THEN_HOLD.has(status) || status > SERVER_ERROR
    ? "retryThenHold"
    : "fail";
};

const TIMEOUT = 408;

const TOO_MANY_REQUESTS = 429;

const CooldownBody = Schema.Struct({
  code: Schema.Literal("model_cooldown"),
  reset_seconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

const Cooldown = Schema.Union([
  CooldownBody,
  Schema.Struct({ error: CooldownBody }),
]);

const decodeCooldown = Schema.decodeUnknownOption(
  Schema.fromJsonString(Cooldown)
);

const RETRY_AFTER =
  /["']?retry-after["']?\s*[:=]\s*["']?(?<value>[^\r\n"}]+)/iu;

const retryHeaderAt = (header: string, now: number) =>
  /^\d+(?:\.\d+)?$/u.test(header)
    ? now + Number(header) * 1000
    : Date.parse(header);

export const retryAfterOf = (
  message: string,
  status: number | null,
  now: number
): number | undefined => {
  const body = message.slice(
    message.indexOf("{"),
    message.lastIndexOf("}") + 1
  );

  const cooldown =
    status === TOO_MANY_REQUESTS
      ? decodeCooldown(body).pipe(
          Option.map(
            (decoded) =>
              now +
              ("error" in decoded
                ? decoded.error.reset_seconds
                : decoded.reset_seconds) *
                1000
          ),
          Option.getOrUndefined
        )
      : undefined;

  const header = RETRY_AFTER.exec(message)?.groups?.value?.trim();

  const retryAfter =
    header === undefined ? Number.NaN : retryHeaderAt(header, now);

  const hints = [cooldown, retryAfter].filter(
    (hint): hint is number => hint !== undefined && Number.isFinite(hint)
  );

  return hints.length === 0 ? undefined : Math.max(now, ...hints);
};

export const causeOf = (status: number | null): ProviderCause => {
  if (status === TIMEOUT) {
    return "timeout";
  }

  return status === TOO_MANY_REQUESTS ? "busy" : "server";
};
