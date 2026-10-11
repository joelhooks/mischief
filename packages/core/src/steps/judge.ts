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
      reason:
        "this host has no Jev judge wired. Wire one (the CLI host takes MISCHIEF_JEV_KEY, a TypeSafe key) or give the judge step a fallback transition, then resume the run",
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
