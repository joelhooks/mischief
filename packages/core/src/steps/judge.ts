import { Context, Effect, Layer } from "effect";
import type { Schema } from "effect";

import { StepFailed } from "./step-failed.js";
import type { StepCall } from "./step-failed.js";
import type { Usage } from "./usage.js";

export interface Judgement {
  readonly probabilities: Readonly<Record<string, number>>;
  readonly usage: Usage;
}

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
        readonly docs: Readonly<Record<string, Schema.Json>>;
        readonly options: readonly string[];
        readonly question: string;
      }
    ) => Effect.Effect<Judgement, StepFailed>;
  }
>()("@mischief/core/Judge") {
  static readonly unwired = Layer.succeed(this, {
    choose: unwired,
  });
}
