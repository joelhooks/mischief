import { Context, Effect, Layer } from "effect";
import type { Option, Schema } from "effect";

import type { AgentConfig, Envelope } from "../plans/schema.js";
import type { ProviderUnavailable } from "./provider-unavailable.js";
import type { ThinkReceipt } from "./receipt.js";
import { StepFailed } from "./step-failed.js";
import type { StepCall } from "./step-failed.js";
import type { ThinkModelUnmapped } from "./think-model-unmapped.js";
import type { Usage } from "./usage.js";

export interface Thought {
  readonly output: string;
  readonly tokens: number;
  readonly cacheRead?: number;
  readonly receipt?: ThinkReceipt;
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

export type ThinkCall = StepCall & {
  readonly agent: AgentConfig;
  readonly ceiling: Envelope["maxThinking"];
  readonly prompt: string;
};

export class Thinker extends Context.Service<
  Thinker,
  {
    readonly think: (
      call: ThinkCall
    ) => Effect.Effect<Thought, StepFailed | ProviderUnavailable>;
    readonly thinkUnrecorded?: (
      call: ThinkCall
    ) => Effect.Effect<Thought, StepFailed | ProviderUnavailable>;
    readonly decide: (
      call: StepCall & {
        readonly agent: AgentConfig;
        readonly ceiling: Envelope["maxThinking"];
        readonly options: readonly string[];
        readonly question: string;
      }
    ) => Effect.Effect<
      Deliberation,
      StepFailed | ThinkModelUnmapped | ProviderUnavailable
    >;
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
