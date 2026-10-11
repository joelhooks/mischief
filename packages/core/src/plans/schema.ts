import { Schema } from "effect";

export const Probability = Schema.Finite.check(
  Schema.isBetween({ maximum: 1, minimum: 0 })
);

export const Count = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);

export const StateKey = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_]{0,31}$/u)
);

export const EventName = Schema.String.check(
  Schema.isPattern(
    /^(?:[a-z][a-z0-9_-]{0,31}|xstate\.done\.state\.[a-z0-9_.-]+)$/u
  )
);

export const DocKey = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/u)
);

export const RatKingName = Schema.String.check(
  Schema.isPattern(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z][a-z0-9_-]{0,31}$/u)
);

export const ModelRef = Schema.String.check(Schema.isMinLength(1));

export const ToolName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/u)
);

export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export const Thinking = Schema.Literals(thinkingLevels);

export const EnvelopeSchema = Schema.Struct({
  extensions: Schema.optionalKey(Schema.Array(ToolName)),
  maxAgents: Count,
  maxDepth: Count,
  maxSteps: Count,
  maxThinking: Thinking,
  models: Schema.NonEmptyArray(ModelRef),
  names: Schema.Array(RatKingName),
  skills: Schema.optionalKey(Schema.Array(ToolName)),
  thresholds: Schema.Struct({
    judge: Probability,
    think: Schema.optionalKey(Probability),
  }),
  tools: Schema.optionalKey(Schema.Array(ToolName)),
});

export type Envelope = typeof EnvelopeSchema.Type;

export const PlacementSchema = Schema.Union([
  Schema.Literal("child"),
  Schema.Struct({ name: RatKingName }),
]);

export type Placement = typeof PlacementSchema.Type;

export const AgentConfigSchema = Schema.Struct({
  extensions: Schema.optionalKey(Schema.Array(ToolName)),
  model: Schema.optionalKey(ModelRef),
  placement: Schema.optionalKey(PlacementSchema),
  skills: Schema.optionalKey(Schema.Array(ToolName)),
  thinking: Schema.optionalKey(Thinking),
  tools: Schema.optionalKey(Schema.Array(ToolName)),
});

export type AgentConfig = typeof AgentConfigSchema.Type;

export const ThinkStepSchema = Schema.Struct({
  agent: Schema.optionalKey(AgentConfigSchema),
  kind: Schema.Literal("think"),
  prompt: Schema.String,
  writes: Schema.optionalKey(DocKey),
});

export type ThinkStep = typeof ThinkStepSchema.Type;

export const JudgeStep = Schema.Struct({
  fallback: Schema.optionalKey(Schema.String),
  kind: Schema.Literal("judge"),
  question: Schema.String,
  reads: Schema.optionalKey(Schema.Array(DocKey)),
  threshold: Schema.optionalKey(Probability),
});

export const AskStepSchema = Schema.Struct({
  kind: Schema.Literal("ask"),
  message: Schema.String,
  to: RatKingName,
  writes: Schema.optionalKey(DocKey),
});

export type AskStep = typeof AskStepSchema.Type;

export const AskJoelStep = Schema.Struct({
  kind: Schema.Literal("ask-joel"),
  question: Schema.String,
});

export const SketchStepSchema = Schema.Struct({
  goal: Schema.String,
  kind: Schema.Literal("sketch"),
  next: StateKey,
});

export type SketchStep = typeof SketchStepSchema.Type;

export const Transition = Schema.Struct({ target: StateKey });

export const TransitionsSchema = Schema.Record(EventName, Transition);

export type Transitions = typeof TransitionsSchema.Type;

export const FinalState = Schema.Struct({ type: Schema.Literal("final") });

export const BranchStepState = Schema.Struct({
  meta: Schema.Struct({ step: Schema.Union([ThinkStepSchema, AskStepSchema]) }),
  on: TransitionsSchema,
});

export const BranchStateSchema = Schema.Union([FinalState, BranchStepState]);

export type BranchState = typeof BranchStateSchema.Type;

export const BranchSchema = Schema.Struct({
  initial: StateKey,
  states: Schema.Record(StateKey, BranchStateSchema),
});

export type Branch = typeof BranchSchema.Type;

export const Join = Schema.Literals(["allSettled", "failFast"]);

export const ParallelStepSchema = Schema.Struct({
  branches: Schema.Record(StateKey, BranchSchema),
  join: Join,
  kind: Schema.Literal("parallel"),
});

export type ParallelStep = typeof ParallelStepSchema.Type;

export const StepSchema = Schema.Union([
  ThinkStepSchema,
  JudgeStep,
  AskStepSchema,
  AskJoelStep,
  SketchStepSchema,
  ParallelStepSchema,
]);

export type Step = typeof StepSchema.Type;

export const StepStateSchema = Schema.Struct({
  meta: Schema.Struct({ step: StepSchema }),
  on: Schema.optionalKey(TransitionsSchema),
});

export type StepState = typeof StepStateSchema.Type;

export interface CompoundState {
  readonly description?: string;
  readonly initial: string;
  readonly meta?: {
    readonly elaboratedFrom: SketchStep;
    readonly version: number;
  };
  readonly on?: Transitions;
  readonly states: Readonly<Record<string, StateNode>>;
}

export type StateNode = typeof FinalState.Type | StepState | CompoundState;

export const CompoundStateSchema: Schema.Codec<CompoundState> = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  initial: StateKey,
  meta: Schema.optionalKey(
    Schema.Struct({ elaboratedFrom: SketchStepSchema, version: Count })
  ),
  on: Schema.optionalKey(TransitionsSchema),
  states: Schema.Record(
    StateKey,
    // oxlint-disable-next-line eslint/no-use-before-define -- a compound state holds state nodes, so the schema is recursive.
    Schema.suspend((): Schema.Codec<StateNode> => StateNodeSchema)
  ),
});

export const StateNodeSchema: Schema.Codec<StateNode> = Schema.Union([
  FinalState,
  StepStateSchema,
  CompoundStateSchema,
]);

export const PlanId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u)
);

export const PlanMachine = Schema.Struct({
  id: PlanId,
  initial: StateKey,
  states: Schema.Record(StateKey, StateNodeSchema),
});

export const PlanSchema = Schema.Struct({
  defaults: Schema.Struct({
    agent: AgentConfigSchema,
    placement: Schema.optionalKey(PlacementSchema),
  }),
  envelope: EnvelopeSchema,
  goal: Schema.optionalKey(Schema.String),
  id: PlanId,
  machine: PlanMachine,
  version: Count,
});

export type Plan = typeof PlanSchema.Type;

export const AmendmentSchema = Schema.Struct({
  initial: StateKey,
  states: Schema.Record(StateKey, StateNodeSchema),
});

export type Amendment = typeof AmendmentSchema.Type;

export const strict = { onExcessProperty: "error" } as const;

export const decodePlan = Schema.decodeUnknownEffect(PlanSchema, strict);

export const decodeAmendment = Schema.decodeUnknownEffect(
  AmendmentSchema,
  strict
);
