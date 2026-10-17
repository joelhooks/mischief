import { Context, Effect, Layer, Result, Schema } from "effect";

export const THINK_CONCURRENCY_FLAG = "MISCHIEF_THINK_CONCURRENCY";

export const DEFAULT_THINK_CONCURRENCY = 20;

export const ThinkConcurrency = Context.Reference<number>(
  "@mischief/core/ThinkConcurrency",
  { defaultValue: () => DEFAULT_THINK_CONCURRENCY }
);

export class ThinkConcurrencyRefused extends Schema.TaggedError<ThinkConcurrencyRefused>()(
  "ThinkConcurrencyRefused",
  { given: Schema.String }
) {
  override get message() {
    return `${THINK_CONCURRENCY_FLAG}="${this.given}" is refused: it caps the think calls one run sends to the model at once, so it must be a positive whole number such as ${DEFAULT_THINK_CONCURRENCY}. Set ${THINK_CONCURRENCY_FLAG}=${DEFAULT_THINK_CONCURRENCY}, or leave it unset for the default of ${DEFAULT_THINK_CONCURRENCY}, then start the host again`;
  }
}

export const thinkConcurrencyFrom = (
  text: string | undefined
): Result.Result<number, ThinkConcurrencyRefused> => {
  const given = (text ?? "").trim();

  if (given === "") {
    return Result.succeed(DEFAULT_THINK_CONCURRENCY);
  }

  return /^[1-9]\d*$/u.test(given) && Number.isSafeInteger(Number(given))
    ? Result.succeed(Number(given))
    : Result.fail(new ThinkConcurrencyRefused({ given }));
};

export const thinkConcurrencyLayer = (text: string | undefined) =>
  Layer.effect(
    ThinkConcurrency,
    Effect.fromResult(thinkConcurrencyFrom(text)).pipe(Effect.orDie)
  );
