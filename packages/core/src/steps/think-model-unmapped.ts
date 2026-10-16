import { Data } from "effect";

export class ThinkModelUnmapped extends Data.TaggedError("ThinkModelUnmapped")<{
  readonly key: string;
  readonly mapped: readonly string[];
  readonly model: string;
}> {}

export const unmappedReason = ({ mapped, model }: ThinkModelUnmapped) =>
  `ThinkModelUnmapped: the think rung asks for model "${model}", which this host does not map (mapped: ${mapped.join(", ") || "none"}), so no model weighed in and the judge came to you. Fix: answer the question. To let the think rung decide next time, set the plan's defaults.agent.model to a mapped model, or drop envelope.thresholds.think to send every sub-threshold verdict straight to you.`;
