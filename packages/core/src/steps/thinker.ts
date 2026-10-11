import { Context, Effect, Layer } from "effect";
import type { Option, Schema } from "effect";

import type { AgentConfig } from "../plans/schema.js";
import { StepFailed } from "./step-failed.js";
import type { StepCall } from "./step-failed.js";
import type { Usage } from "./usage.js";

export interface Thought {
  readonly output: string;
  readonly tokens: number;
}

export interface Decision {
  readonly choice: string;
  readonly confidence: number;
}

export interface Deliberation {
  readonly decision: Option.Option<Decision>;
  readonly usage: Usage;
}

export interface Elaboration {
  readonly amendment: Schema.Json;
  readonly tokens: number;
}

const unwired = (call: StepCall) =>
  Effect.fail(
    new StepFailed({
      key: call.key,
      reason: "Thinker is not wired on this host",
    })
  );

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
    ) => Effect.Effect<Deliberation, StepFailed>;
    readonly elaborate: (
      call: StepCall & { readonly goal: string }
    ) => Effect.Effect<Elaboration, StepFailed>;
  }
>()("@mischief/core/Thinker") {
  static readonly unwired = Layer.succeed(this, {
    decide: unwired,
    elaborate: unwired,
    think: unwired,
  });
}
