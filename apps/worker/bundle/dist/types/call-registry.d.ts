import { Context, Effect, Schema } from "effect";
import { StepFailed } from "./step-failed.js";
import type { StepCall } from "./step-failed.js";
export interface CallSpec<I, O> {
    readonly input: Schema.Codec<I, Schema.Json>;
    readonly output: Schema.Codec<O, Schema.Json>;
    readonly run: (input: I, call: StepCall) => Effect.Effect<O, StepFailed>;
}
export interface Callable {
    readonly invoke: (input: Schema.Json, call: StepCall) => Effect.Effect<Schema.Json, StepFailed>;
}
export declare const callable: <I, O>(spec: CallSpec<I, O>) => Callable;
export declare const CallRegistry: Context.Reference<ReadonlyMap<string, Callable>>;
//# sourceMappingURL=call-registry.d.ts.map