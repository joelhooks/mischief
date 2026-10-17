import { Context, Effect, Schema } from "effect";

import { StepFailed } from "./step-failed.js";
import type { StepCall } from "./step-failed.js";

export interface CallSpec<I, O> {
  readonly input: Schema.Codec<I, Schema.Json>;
  readonly output: Schema.Codec<O, Schema.Json>;
  readonly run: (input: I, call: StepCall) => Effect.Effect<O, StepFailed>;
}

export interface Callable {
  readonly invoke: (
    input: Schema.Json,
    call: StepCall
  ) => Effect.Effect<Schema.Json, StepFailed>;
}

export const callable = <I, O>(spec: CallSpec<I, O>): Callable => ({
  invoke: (input, call) =>
    Schema.decodeEffect(spec.input)(input).pipe(
      Effect.mapError(
        (issue) =>
          new StepFailed({
            key: call.key,
            reason: `its input does not decode with the capability's input schema: ${issue.message}. Fix the step's input or the docs it reads`,
          })
      ),
      Effect.flatMap((decoded) => spec.run(decoded, call)),
      Effect.flatMap((output) =>
        Schema.encodeEffect(spec.output)(output).pipe(
          Effect.mapError(
            (issue) =>
              new StepFailed({
                key: call.key,
                reason: `the capability returned output its output schema refuses, so nothing was recorded: ${issue.message}`,
              })
          )
        )
      )
    ),
});

export const CallRegistry = Context.Reference<ReadonlyMap<string, Callable>>(
  "@mischief/core/CallRegistry",
  { defaultValue: () => new Map() }
);
