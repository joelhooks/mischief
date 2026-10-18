import { Context, Effect, Layer, Result, Schema } from "effect";

export const CALL_CONCURRENCY_FLAG = "MISCHIEF_CALL_CONCURRENCY";

export const DEFAULT_CALL_CONCURRENCY = 16;

export const CallConcurrency = Context.Reference<number>(
  "@mischief/core/CallConcurrency",
  { defaultValue: () => DEFAULT_CALL_CONCURRENCY }
);

export class CallConcurrencyRefused extends Schema.TaggedError<CallConcurrencyRefused>()(
  "CallConcurrencyRefused",
  { given: Schema.String }
) {
  override get message() {
    return `${CALL_CONCURRENCY_FLAG}="${this.given}" is refused: it caps the capability calls one run invokes at once, so it must be a positive whole number such as ${DEFAULT_CALL_CONCURRENCY}. Set ${CALL_CONCURRENCY_FLAG}=${DEFAULT_CALL_CONCURRENCY}, or leave it unset for the default of ${DEFAULT_CALL_CONCURRENCY}, then start the host again`;
  }
}

export const callConcurrencyFrom = (
  text: string | undefined
): Result.Result<number, CallConcurrencyRefused> => {
  const given = (text ?? "").trim();

  if (given === "") {
    return Result.succeed(DEFAULT_CALL_CONCURRENCY);
  }

  return /^[1-9]\d*$/u.test(given) && Number.isSafeInteger(Number(given))
    ? Result.succeed(Number(given))
    : Result.fail(new CallConcurrencyRefused({ given }));
};

export const callConcurrencyLayer = (text: string | undefined) =>
  Layer.effect(
    CallConcurrency,
    Effect.fromResult(callConcurrencyFrom(text)).pipe(Effect.orDie)
  );
