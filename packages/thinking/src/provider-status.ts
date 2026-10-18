import type { ProviderCause } from "@mischief/core";

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

export const causeOf = (status: number | null): ProviderCause => {
  if (status === TIMEOUT) {
    return "timeout";
  }

  return status === TOO_MANY_REQUESTS ? "busy" : "server";
};
