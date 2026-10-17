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

export const CriterionSchema = Schema.Union([
  Schema.String.check(Schema.isNonEmpty()),
  Schema.Array(Schema.Json).check(Schema.isMinLength(1)),
  Schema.Record(Schema.String, Schema.Json).check(Schema.isMinProperties(1)),
]).annotate({
  description:
    "What choosing this transition means, sent to the judge as its criterion: a non-empty string, array or object",
});

export const CriteriaSchema = Schema.Record(EventName, CriterionSchema);

export type Criteria = typeof CriteriaSchema.Type;

export const JudgeStepSchema = Schema.Struct({
  criteria: Schema.optionalKey(
    CriteriaSchema.annotate({
      description:
        "One criterion per transition in on, keyed by the same names. Required when the run's judge is jev. A judge whose transitions are exactly yes and no is asked as a yes/no question",
    })
  ),
  fallback: Schema.optionalKey(Schema.String),
  kind: Schema.Literal("judge"),
  question: Schema.String,
  reads: Schema.optionalKey(Schema.Array(DocKey)),
  threshold: Schema.optionalKey(Probability),
});

export type JudgeStep = typeof JudgeStepSchema.Type;

export const SwitchStepSchema = Schema.Struct({
  cases: Schema.Record(Schema.String, EventName),
  default: EventName,
  kind: Schema.Literal("switch"),
  reads: DocKey,
});

export type SwitchStep = typeof SwitchStepSchema.Type;

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

export const CapabilityName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u)
);

export const CallStepSchema = Schema.Struct({
  capability: CapabilityName,
  input: Schema.optionalKey(Schema.Json),
  kind: Schema.Literal("call"),
  reads: Schema.optionalKey(Schema.Array(DocKey)),
  writes: Schema.optionalKey(DocKey),
}).annotate({
  description:
    "Invoke a capability the host registered, by name, then enter on.done. Its input is input as written, or with reads an object of those docs by name; writes puts the output in a doc. The output is recorded in the run's journal, so a replay reuses it and never calls again. A crash between the call and the commit that records it repeats the call, so the call is at least once: the capability must be idempotent for its run, step and visit, which it receives with the input. Off unless the host enables it",
});

export type CallStep = typeof CallStepSchema.Type;

export const Transition = Schema.Struct({ target: StateKey });

export const TransitionsSchema = Schema.Record(EventName, Transition);

export type Transitions = typeof TransitionsSchema.Type;

export const FinalState = Schema.Struct({ type: Schema.Literal("final") });

export const BranchStepSchema = Schema.Union([
  ThinkStepSchema,
  AskStepSchema,
  JudgeStepSchema,
  SwitchStepSchema,
]);

export type BranchStep = typeof BranchStepSchema.Type;

export const BranchStepState = Schema.Struct({
  meta: Schema.Struct({ step: BranchStepSchema }),
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
  JudgeStepSchema,
  SwitchStepSchema,
  AskStepSchema,
  AskJoelStep,
  SketchStepSchema,
  ParallelStepSchema,
  CallStepSchema,
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
