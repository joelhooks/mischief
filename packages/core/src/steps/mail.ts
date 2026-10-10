import { Context, Effect, Layer } from "effect";

import { StepFailed } from "./step-failed.js";
import type { StepCall } from "./step-failed.js";

const unwired = (call: StepCall) =>
  Effect.fail(
    new StepFailed({
      key: call.key,
      reason: "Mail is not wired on this host",
    })
  );

export class Mail extends Context.Service<
  Mail,
  {
    readonly ask: (
      call: StepCall & { readonly message: string; readonly to: string }
    ) => Effect.Effect<string, StepFailed>;
  }
>()("@mischief/core/Mail") {
  static readonly unwired = Layer.succeed(this, {
    ask: unwired,
  });
}
