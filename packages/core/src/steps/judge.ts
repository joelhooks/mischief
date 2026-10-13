import { Context, Effect, Layer, Schema } from "effect";
import type { Option } from "effect";

import type { ProviderUnavailable } from "./provider-unavailable.js";
import { StepFailed } from "./step-failed.js";
import type { StepCall } from "./step-failed.js";
import type { Usage } from "./usage.js";
import type { VerdictDeferred } from "./verdict-deferred.js";

export interface Judgement {
  readonly probabilities: Readonly<Record<string, number>>;
  readonly usage: Usage;
  readonly why?: readonly string[];
}

export const WHY_LINES = 8;

export const WHY_LINE_CHARS = 240;

export const WhySchema = Schema.Array(
  Schema.String.check(Schema.isMaxLength(WHY_LINE_CHARS))
).check(Schema.isMaxLength(WHY_LINES));

export const whyDocName = (key: string) => `${key.replaceAll(".", "-")}-why`;

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
        readonly reply: Option.Option<string>;
      }
    ) => Effect.Effect<
      Judgement,
      StepFailed | VerdictDeferred | ProviderUnavailable
    >;
  }
>()("@mischief/core/Judge") {
  static readonly unwired = Layer.succeed(this, {
    choose: unwired,
  });
}
