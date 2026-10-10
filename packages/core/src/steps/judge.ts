import { Context } from "effect";
import type { Effect } from "effect";

import type { StepCall, StepFailed } from "./step-failed.js";

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
>()("@mischief/core/Judge") {}
