import { Schema } from "effect";
declare const StepFailed_base: Schema.Class<StepFailed, Schema.TaggedStruct<"StepFailed", {
    readonly key: Schema.String;
    readonly reason: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class StepFailed extends StepFailed_base {
    get message(): string;
}
export interface StepCall {
    readonly epoch: number;
    readonly key: string;
    readonly runId: string;
    readonly visit: number;
}
export {};
//# sourceMappingURL=step-failed.d.ts.map