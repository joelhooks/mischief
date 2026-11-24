import { Config, Effect, Redacted } from "effect";

import { refusal } from "../protocol.js";

export const spendKeyFromConfig = Effect.gen(function* readSpendKey() {
  const key = yield* Config.Redacted("MISCHIEF_BOX_SPEND_KEY");

  if (Redacted.value(key).trim() === "") {
    return yield* refusal(
      "Set a nonempty MISCHIEF_BOX_SPEND_KEY shared by the box manager and model proxies, then restart."
    );
  }

  return key;
});
