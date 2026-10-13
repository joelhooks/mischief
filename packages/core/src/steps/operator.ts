import { Context } from "effect";
import type { Effect } from "effect";

import type { Held } from "../runs/schema.js";
import type { QuestionInput } from "./inputs.js";

export class Operator extends Context.Service<
  Operator,
  {
    readonly notify: (
      runId: string,
      question: QuestionInput,
      notice: string
    ) => Effect.Effect<void>;
    readonly held?: (
      runId: string,
      held: Held,
      notice: string
    ) => Effect.Effect<void>;
  }
>()("@mischief/core/Operator") {}
