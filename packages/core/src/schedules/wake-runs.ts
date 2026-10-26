import { Context } from "effect";
import type { Effect, Option, Schema } from "effect";

import type { PlanRefused } from "../plans/validate.js";
import type { Docs, JudgeMode, RunReport } from "../runs/schema.js";

export interface WakeChoices {
  readonly escalateTo: string | null;
  readonly judge: JudgeMode | null;
}

export class WakeRuns extends Context.Service<
  WakeRuns,
  {
    readonly abort: (runId: string, reason?: string) => Effect.Effect<void>;
    readonly inspect: (
      runId: string
    ) => Effect.Effect<Option.Option<RunReport>>;
    readonly submit: (
      runId: string,
      plan: Schema.Json,
      docs: Docs,
      choices: WakeChoices
    ) => Effect.Effect<void, PlanRefused>;
  }
>()("@mischief/core/WakeRuns") {}
