import { Context } from "effect";
import type { Effect } from "effect";

import type { Held, StepFailure } from "../runs/schema.js";
import type { QuestionInput } from "./inputs.js";
import type { ThinkReceipt } from "./receipt.js";

export class Operator extends Context.Service<
  Operator,
  {
    readonly aborted?: (runId: string, reason: string) => Effect.Effect<void>;
    readonly notify: (
      runId: string,
      question: QuestionInput,
      notice: string
    ) => Effect.Effect<void>;
    readonly thought?: (
      runId: string,
      key: string,
      receipt: ThinkReceipt
    ) => Effect.Effect<void>;
    readonly holdAlarm?: (
      runId: string,
      held: readonly Held[],
      attempts: number,
      notice: string
    ) => Effect.Effect<void, string>;
    readonly held?: (
      runId: string,
      held: Held,
      notice: string
    ) => Effect.Effect<void>;
    readonly failed?: (
      runId: string,
      failures: readonly StepFailure[],
      notice: string
    ) => Effect.Effect<void>;
  }
>()("@mischief/core/Operator") {}
