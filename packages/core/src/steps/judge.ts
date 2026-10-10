import { Context, Effect, Layer } from "effect";

import { StepFailed } from "./step-failed.js";
import type { StepCall } from "./step-failed.js";

const unwired = (call: StepCall) =>
  Effect.fail(
    new StepFailed({
      key: call.key,
      reason: "Judge is not wired on this host",
    })
  );

export class Judge extends Context.Service<
  Judge,
  {
    readonly choose: (
      call: StepCall & {
        readonly options: readonly string[];
        readonly question: string;
      }
    ) => Effect.Effect<Readonly<Record<string, number>>, StepFailed>;
  }
>()("@mischief/core/Judge") {
  static readonly unwired = Layer.succeed(this, {
    choose: unwired,
  });
}
