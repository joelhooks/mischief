import { Effect, Schema } from "effect";
import { absurd, constFalse, constVoid } from "effect/Function";
import { createAsyncLogic, createMachineFromConfig } from "xstate";

import { branchLength, compilePlan, isCompound, isFinal } from "./compile.js";
import type {
  AgentConfig,
  AskStep,
  Branch,
  BranchState,
  Plan,
  StateNode,
  Step,
  ThinkStep,
} from "./schema.js";
import { decodePlan, thinkingLevels } from "./schema.js";

export class PlanRefused extends Schema.TaggedError<PlanRefused>()(
  "PlanRefused",
  { errors: Schema.Array(Schema.String) }
) {
  override get message() {
    return `Plan refused, nothing was stored. Fix each problem and call submitPlan again:\n${this.errors.map((error) => `- ${error}`).join("\n")}`;
  }
}

export const BASE_TOOLS = [
  "plan-docs.read",
  "plan-docs.write",
  "report",
  "ask-parent",
] as const;

const BRANCH_STEPS = new Set<Step["kind"]>(["think", "ask"]);

const codeKeys = new Set(["@code", "@expr"]);

const isJsonObject = Schema.is(Schema.JsonObject);

const findCode = (value: Schema.Json, path: string): readonly string[] => {
  const entries = isJsonObject(value) ? Object.entries(value) : [];

  const children: readonly (readonly [string, Schema.Json])[] = Array.isArray(
    value
  )
    ? value.map((child, index) => [String(index), child] as const)
    : entries;

  return children.flatMap(([key, child]) =>
    codeKeys.has(key)
      ? [
          `${path}.${key}: plans are data, so @code and @expr are refused. Express the logic as steps and transitions instead`,
        ]
      : findCode(child, `${path}.${key}`)
  );
};

interface Checked<A> {
  readonly agents: number;
  readonly errors: readonly string[];
  readonly value: A;
}

interface Merged<A> {
  readonly agents: number;
  readonly errors: readonly string[];
  readonly values: readonly A[];
}

const merge = <A>(parts: readonly Checked<A>[]): Merged<A> => ({
  agents: parts.reduce((sum, part) => sum + part.agents, 0),
  errors: parts.flatMap((part) => part.errors),
  values: parts.map((part) => part.value),
});

const resolveThink = (
  plan: Plan,
  step: ThinkStep,
  where: string
): Checked<ThinkStep> => {
  const { envelope, defaults } = plan;
  const merged: AgentConfig = { ...defaults.agent, ...step.agent };
  const tools = [...new Set([...BASE_TOOLS, ...(merged.tools ?? [])])];

  const placement =
    step.agent?.placement ?? defaults.placement ?? ("child" as const);

  const model = merged.model ?? envelope.models[0];
  const thinking = merged.thinking ?? "low";

  const allowedTools = new Set<string>([
    ...BASE_TOOLS,
    ...(envelope.tools ?? []),
  ]);

  const errors = [
    ...(envelope.models.includes(model)
      ? []
      : [
          `${where}: model "${model}" is outside the envelope. Use one of: ${envelope.models.join(", ")}, or widen envelope.models`,
        ]),
    ...(thinkingLevels.indexOf(thinking) >
    thinkingLevels.indexOf(envelope.maxThinking)
      ? [
          `${where}: thinking "${thinking}" exceeds envelope.maxThinking "${envelope.maxThinking}". Use ${thinkingLevels.slice(0, thinkingLevels.indexOf(envelope.maxThinking) + 1).join(", ")}`,
        ]
      : []),
    ...tools.flatMap((tool) =>
      allowedTools.has(tool)
        ? []
        : [
            `${where}: tool "${tool}" is outside the envelope. Allowed: ${[...allowedTools].join(", ")}, or add it to envelope.tools`,
          ]
    ),
  ];

  return {
    agents: 1,
    errors,
    value: { ...step, agent: { model, placement, thinking, tools } },
  };
};

const resolveAsk = (
  plan: Plan,
  step: AskStep,
  where: string
): Checked<AskStep> => ({
  agents: 1,
  errors: plan.envelope.names.includes(step.to)
    ? []
    : [
        `${where}: Rat King name "${step.to}" is not on the envelope allowlist. Allowed: ${plan.envelope.names.join(", ") || "none"}, or add it to envelope.names`,
      ],
  value: step,
});

const resolveBranch = (
  plan: Plan,
  branch: Branch,
  path: readonly string[]
): Checked<Branch> => {
  const where = path.join(".");

  const parts = Object.entries(branch.states).map(
    ([name, node]): Checked<readonly [string, BranchState]> => {
      if (isFinal(node)) {
        return { agents: 0, errors: [], value: [name, node] };
      }

      const nodeWhere = `${where}.${name}`;
      const { step } = node.meta;

      const resolved =
        step.kind === "think"
          ? resolveThink(plan, step, nodeWhere)
          : resolveAsk(plan, step, nodeWhere);

      return {
        agents: resolved.agents,
        errors: resolved.errors,
        value: [name, { ...node, meta: { step: resolved.value } }],
      };
    }
  );

  const { agents, errors, values } = merge(parts);

  return {
    agents,
    errors: [
      ...(branchLength(branch) === undefined
        ? [
            `${where}: a branch must be a straight line, each step with exactly one transition, ending in a { "type": "final" } state`,
          ]
        : []),
      ...errors,
    ],
    value: { ...branch, states: Object.fromEntries(values) },
  };
};

const depthErrorsAt = (plan: Plan, path: readonly string[]) =>
  path.length > plan.envelope.maxDepth
    ? [
        `${path.join(".")}: nesting depth ${path.length} exceeds envelope.maxDepth ${plan.envelope.maxDepth}. Flatten the compound state or raise maxDepth`,
      ]
    : [];

const resolveNode = (
  plan: Plan,
  node: StateNode,
  path: readonly string[]
): Checked<StateNode> => {
  const where = path.join(".");

  const depthErrors = depthErrorsAt(plan, path);

  if (isFinal(node)) {
    return { agents: 0, errors: depthErrors, value: node };
  }

  if (isCompound(node)) {
    // oxlint-disable-next-line eslint/no-use-before-define -- compound states resolve their children, which resolve nodes.
    const children = resolveStates(plan, node.states, path);

    return {
      agents: children.agents,
      errors: [...depthErrors, ...children.errors],
      value: { ...node, states: children.value },
    };
  }

  const { step } = node.meta;
  const choiceCount = Object.keys(node.on ?? {}).length;

  const choiceErrors =
    (step.kind === "judge" || step.kind === "ask-joel") && choiceCount < 2
      ? [
          `${where}: ${step.kind} needs at least two transitions in "on", one per option it can choose`,
        ]
      : [];

  switch (step.kind) {
    case "think": {
      const resolved = resolveThink(plan, step, where);

      return {
        agents: resolved.agents,
        errors: [...depthErrors, ...resolved.errors],
        value: { ...node, meta: { step: resolved.value } },
      };
    }

    case "ask": {
      const resolved = resolveAsk(plan, step, where);

      return {
        agents: resolved.agents,
        errors: [...depthErrors, ...resolved.errors],
        value: { ...node, meta: { step: resolved.value } },
      };
    }

    case "judge": {
      return {
        agents: 0,
        errors: [...depthErrors, ...choiceErrors],
        value: {
          ...node,
          meta: {
            step: {
              ...step,
              threshold: step.threshold ?? plan.envelope.thresholds.judge,
            },
          },
        },
      };
    }

    case "parallel": {
      const branches = Object.entries(step.branches).map(
        ([name, branch]): Checked<readonly [string, Branch]> => {
          const resolved = resolveBranch(plan, branch, [...path, name]);

          return { ...resolved, value: [name, resolved.value] };
        }
      );

      const merged = merge(branches);

      const parallelErrors = [
        ...(branches.length < 2
          ? [
              `${where}: parallel needs at least two branches; a single branch is just a sequence of steps`,
            ]
          : []),
        ...(node.on?.done === undefined
          ? [
              `${where}: parallel needs on.done, the state to enter when every branch settles`,
            ]
          : []),
        ...(step.join === "failFast" && node.on?.failed === undefined
          ? [
              `${where}: join "failFast" needs on.failed, the state to enter when the first branch fails`,
            ]
          : []),
        ...Object.values(step.branches).flatMap((branch) =>
          Object.values(branch.states).flatMap((state) =>
            isFinal(state) || BRANCH_STEPS.has(state.meta.step.kind)
              ? []
              : [
                  `${where}: a parallel branch may only hold think and ask steps. Move judge, ask-joel, sketch or parallel steps after the fan-out`,
                ]
          )
        ),
      ];

      return {
        agents: merged.agents,
        errors: [...depthErrors, ...parallelErrors, ...merged.errors],
        value: {
          ...node,
          meta: {
            step: { ...step, branches: Object.fromEntries(merged.values) },
          },
        },
      };
    }

    case "ask-joel":
    case "sketch": {
      return {
        agents: 0,
        errors: [...depthErrors, ...choiceErrors],
        value: node,
      };
    }

    default: {
      return absurd(step);
    }
  }
};

const resolveStates = (
  plan: Plan,
  states: Readonly<Record<string, StateNode>>,
  prefix: readonly string[]
): Checked<Record<string, StateNode>> => {
  const parts = Object.entries(states).map(
    ([name, node]): Checked<readonly [string, StateNode]> => {
      const resolved = resolveNode(plan, node, [...prefix, name]);

      return { ...resolved, value: [name, resolved.value] };
    }
  );

  const { agents, errors, values } = merge(parts);

  return { agents, errors, value: Object.fromEntries(values) };
};

const probeLogic = createAsyncLogic({
  // oxlint-disable-next-line typescript/promise-function-async -- xstate async logic consumes a Promise factory.
  run: () => Promise.resolve(),
});

const probeSources = {
  actions: { askJoel: constVoid },
  actors: {
    ask: probeLogic,
    elaborate: probeLogic,
    judge: probeLogic,
    think: probeLogic,
  },
  guards: { escalated: constFalse, picked: constFalse },
};

const hydrationErrors = (plan: Plan): readonly string[] => {
  try {
    createMachineFromConfig(compilePlan(plan), probeSources);

    return [];
  } catch (error) {
    return [
      `xstate: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
};

export const refuseCode = (input: Schema.Json) => {
  const code = findCode(input, "$");

  return code.length > 0 ? new PlanRefused({ errors: code }) : Effect.void;
};

export const checkPlan = Effect.fn("checkPlan")(function* checkPlan(
  plan: Plan
) {
  const resolved = resolveStates(plan, plan.machine.states, []);

  const resolvedPlan: Plan = {
    ...plan,
    machine: { ...plan.machine, states: resolved.value },
  };

  const errors = [
    ...resolved.errors,
    ...(resolved.agents > plan.envelope.maxAgents
      ? [
          `plan has ${resolved.agents} agent steps (think and ask), envelope.maxAgents allows ${plan.envelope.maxAgents}. Cut steps or raise maxAgents`,
        ]
      : []),
  ];

  if (errors.length > 0) {
    return yield* new PlanRefused({ errors });
  }

  const hydration = hydrationErrors(resolvedPlan);

  if (hydration.length > 0) {
    return yield* new PlanRefused({ errors: hydration });
  }

  return resolvedPlan;
});

export const validatePlan = Effect.fn("validatePlan")(function* validatePlan(
  input: Schema.Json
) {
  yield* refuseCode(input);

  const plan = yield* decodePlan(input).pipe(
    Effect.mapError((issue) => new PlanRefused({ errors: [issue.message] }))
  );

  return yield* checkPlan(plan);
});
