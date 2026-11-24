import { Effect, Schema } from "effect";

import { PeonId } from "./protocol.js";

export const ADMIT_PATH = "/internal/model-spend/admit";

export const RECORD_PATH = "/internal/model-spend/record";

const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
);

const Positive = Counter.check(Schema.isGreaterThan(0));

export const BoxImageKey = Schema.Literals(["browser", "full"]);

const BoxOwnerSchema = Schema.Struct({
  peonId: PeonId,
  imageKey: BoxImageKey,
});

export type BoxOwner = typeof BoxOwnerSchema.Type;

const Limits = Schema.Struct({
  dailyTokens: Positive,
  defaultOutputTokens: Schema.optionalKey(Positive),
  ratePerMin: Positive,
});

export const SpendLimits = Schema.Struct({
  browser: Limits.pipe(
    Schema.withDecodingDefaultKey(
      Effect.succeed({ dailyTokens: 2_000_000, ratePerMin: 20 })
    )
  ),
  full: Schema.optionalKey(Limits),
});

export type SpendLimitsConfig = typeof SpendLimits.Type;

const Receipt = Schema.String.check(Schema.isUUID());

export const SpendAdmission = Schema.Struct({
  peer: Schema.String,
  requestId: Schema.optionalKey(Receipt),
  tokens: Counter,
  outputTokens: Schema.optionalKey(Positive),
});

export const SpendPermit = Schema.Union([
  Schema.Struct({ status: Schema.Literal("uncapped") }),
  Schema.Struct({
    status: Schema.Literal("metered"),
    receipt: Receipt,
    outputTokens: Positive,
  }),
  Schema.Struct({
    status: Schema.Literal("denied"),
    reason: Schema.Literals(["rate", "daily"]),
  }),
]);

export type SpendAdmissionResult = typeof SpendPermit.Type;

export const SpendReading = Schema.Struct({
  receipt: Receipt,
  tokens: Counter,
  settled: Schema.optionalKey(Schema.Literal(true)),
});

export const SpendProgress = Schema.Struct({ allowed: Schema.Boolean });

export const spendReading = (
  receipt: string,
  tokens: number,
  settled: boolean
): typeof SpendReading.Type => {
  const reading = { receipt, tokens };

  return settled ? { ...reading, settled: true } : reading;
};

export const spendMessage = (reason: "rate" | "daily") =>
  reason === "rate"
    ? "SpendCap: HTTP 429. This peon reached its rolling model request limit. Wait at least one minute, then retry promptPeon."
    : "SpendCap: HTTP 429. This peon has insufficient daily model tokens. Retry promptPeon after midnight UTC or ask the peons desk to review the cap.";
