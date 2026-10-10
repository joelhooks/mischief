import { Context } from "effect";
import type { Effect } from "effect";

import type { QuestionInput } from "./inputs.js";

export class Operator extends Context.Service<
  Operator,
  {
    readonly notify: (
      runId: string,
      question: QuestionInput
    ) => Effect.Effect<void>;
  }
>()("@mischief/core/Operator") {}
