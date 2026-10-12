import { Context } from "effect";
import type { Effect, Option, Schema } from "effect";

import type { PlanRefused } from "../plans/validate.js";
import type { Docs, RunReport } from "../runs/schema.js";

export class WakeRuns extends Context.Service<
  WakeRuns,
  {
    readonly abort: (runId: string) => Effect.Effect<void>;
    readonly inspect: (
      runId: string
    ) => Effect.Effect<Option.Option<RunReport>>;
    readonly submit: (
      runId: string,
      plan: Schema.Json,
      docs: Docs
    ) => Effect.Effect<void, PlanRefused>;
  }
>()("@mischief/core/WakeRuns") {}
