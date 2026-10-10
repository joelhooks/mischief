import { Context } from "effect";
import type { Effect, Option, Schema } from "effect";

import type { AgentConfig } from "../plans/schema.js";
import type { StepCall, StepFailed } from "./step-failed.js";

export interface Thought {
  readonly output: string;
  readonly tokens: number;
}

export interface Decision {
  readonly choice: string;
  readonly confidence: number;
}

export interface Elaboration {
  readonly amendment: Schema.Json;
  readonly tokens: number;
}

export class Thinker extends Context.Service<
  Thinker,
  {
    readonly think: (
      call: StepCall & {
        readonly agent: AgentConfig;
        readonly prompt: string;
      }
    ) => Effect.Effect<Thought, StepFailed>;
    readonly decide: (
      call: StepCall & {
        readonly options: readonly string[];
        readonly question: string;
      }
    ) => Effect.Effect<Option.Option<Decision>, StepFailed>;
    readonly elaborate: (
      call: StepCall & { readonly goal: string }
    ) => Effect.Effect<Elaboration, StepFailed>;
  }
>()("@mischief/core/Thinker") {}
