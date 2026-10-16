import { absurd } from "effect/Function";
import type { StateNodeJSON, TransitionJSON } from "xstate";

import type {
  AgentConfig,
  Branch,
  BranchState,
  CompoundState,
  Criteria,
  Plan,
  StateNode,
  StepState,
  Transitions,
} from "./schema.js";

export const AMENDED = "mischief.amended";

export const FAILED_BRANCH = "__failed";

export const REPLY_SUFFIX = "__reply";

export const replyEvent = (key: string) => `mischief.reply.${key}`;

export interface CompiledMachine extends StateNodeJSON {
  readonly id: string;
  readonly initial: string;
  readonly states: Record<string, StateNodeJSON>;
  readonly version: string;
}

interface Scope {
  readonly machineId: string;
  readonly onError: string | undefined;
  readonly thinkAgent: AgentConfig | undefined;
  readonly thinkThreshold: number | undefined;
}

export const isFinal = (
  node: StateNode | BranchState
): node is { readonly type: "final" } => "type" in node;

export const isCompound = (node: StateNode): node is CompoundState =>
  "states" in node;

export const isStep = (node: StateNode | BranchState): node is StepState =>
  "meta" in node && node.meta !== undefined && "step" in node.meta;

const targetsIn = (branch: Branch, name: string) => {
  const node = branch.states[name];

  return node === undefined || isFinal(node)
    ? []
    : Object.values(node.on).map(({ target }) => target);
};

const reachableFrom = (branch: Branch, from: string) => {
  const seen = new Set<string>();
  const queue = [from];

  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    if (!seen.has(at)) {
      seen.add(at);
      queue.push(...targetsIn(branch, at));
    }
  }

  return seen;
};

const longestFrom = (
  branch: Branch,
  at: string,
  seen: ReadonlySet<string>
): number => {
  const node = branch.states[at];

  if (node === undefined) {
    return Number.NEGATIVE_INFINITY;
  }

  if (isFinal(node)) {
    return 0;
  }

  const onward = new Set([...seen, at]);

  return Math.max(
    Number.NEGATIVE_INFINITY,
    ...targetsIn(branch, at)
      .filter((target) => !onward.has(target))
      .map((target) => 1 + longestFrom(branch, target, onward))
  );
};

export const branchLength = (branch: Branch): number | undefined => {
  const reachable = reachableFrom(branch, branch.initial);

  const sound = [...reachable].every((name) => {
    const leads = reachableFrom(branch, name);

    return [...leads].some((target) => {
      const node = branch.states[target];

      return node !== undefined && isFinal(node);
    });
  });

  return sound ? longestFrom(branch, branch.initial, new Set()) : undefined;
};

const targetOf = (on: Transitions | undefined, event: string) =>
  on?.[event]?.target ?? "";

const options = (on: Transitions | undefined) => Object.keys(on ?? {});

const picked = (option: string) => ({ params: { option }, type: "picked" });

const choices = (on: Transitions | undefined) =>
  Object.fromEntries(
    options(on).map((option) => [option, { target: targetOf(on, option) }])
  );

const errorTransition = (scope: Scope): { onError?: TransitionJSON } =>
  scope.onError === undefined ? {} : { onError: { target: scope.onError } };

const compileStep = (
  name: string,
  node: StepState,
  path: readonly string[],
  scope: Scope
): (readonly [string, StateNodeJSON])[] => {
  const { step } = node.meta;
  const key = path.join(".");
  const meta = { key, step };

  switch (step.kind) {
    case "think": {
      return [
        [
          name,
          {
            invoke: {
              input: { key, ...step },
              onDone: { target: targetOf(node.on, "done") },
              src: "think",
              ...errorTransition(scope),
            },
            meta,
          },
        ],
      ];
    }

    case "ask": {
      return [
        [
          name,
          {
            invoke: {
              input: { key, ...step },
              onDone: { target: `${name}${REPLY_SUFFIX}` },
              src: "ask",
              ...errorTransition(scope),
            },
            meta,
          },
        ],
        [
          `${name}${REPLY_SUFFIX}`,
          {
            meta: { key, step },
            on: {
              [replyEvent(key)]: { target: targetOf(node.on, "replied") },
            },
          },
        ],
      ];
    }

    case "ask-joel": {
      const ask = { key, options: options(node.on), question: step.question };

      return [
        [
          name,
          {
            entry: [{ params: ask, type: "askJoel" }],
            meta: { ...meta, ask },
            on: choices(node.on),
          },
        ],
      ];
    }

    case "judge": {
      const asked = { key, options: options(node.on), question: step.question };

      const ask =
        step.criteria === undefined
          ? asked
          : { ...asked, criteria: step.criteria };

      return [
        [
          name,
          {
            invoke: {
              input: {
                ...ask,
                fallback: step.fallback,
                reads: step.reads,
                thinkAgent: scope.thinkAgent,
                thinkThreshold: scope.thinkThreshold,
                threshold: step.threshold,
              },
              onDone: [
                ...ask.options.map((option) => ({
                  guard: picked(option),
                  target: targetOf(node.on, option),
                })),
                { guard: { type: "escalated" }, target: `${name}__joel` },
              ],
              src: "judge",
            },
            meta,
          },
        ],
        [
          `${name}__joel`,
          {
            entry: [{ params: ask, type: "askJoel" }],
            meta: {
              ask,
              escalatedFrom: "judge",
              key,
              step: { kind: "ask-joel", question: step.question },
            },
            on: choices(node.on),
          },
        ],
      ];
    }

    case "sketch": {
      return [
        [
          name,
          {
            invoke: {
              input: { goal: step.goal, key },
              onDone: { target: `${name}__amend` },
              src: "elaborate",
            },
            meta,
          },
        ],
        [
          `${name}__amend`,
          { meta: { amend: { next: step.next, path } }, tags: ["amend"] },
        ],
      ];
    }

    case "parallel": {
      const failed =
        step.join === "failFast"
          ? `#${scope.machineId}.${[...path.slice(0, -1), targetOf(node.on, "failed")].join(".")}`
          : FAILED_BRANCH;

      const regions = Object.entries(step.branches).map(
        ([branchName, branch]) =>
          [
            branchName,
            {
              initial: branch.initial,
              states: {
                // oxlint-disable-next-line eslint/no-use-before-define -- parallel steps compile their branches, which compile steps.
                ...compileBranch(branch, [...path, branchName], {
                  ...scope,
                  onError: failed,
                }),
                [FAILED_BRANCH]: { type: "final" },
              },
            },
          ] as const
      );

      return [
        [
          name,
          {
            meta,
            on: {
              [`xstate.done.state.${scope.machineId}.${key}`]: {
                target: targetOf(node.on, "done"),
              },
            },
            states: Object.fromEntries(regions),
            type: "parallel",
          },
        ],
      ];
    }

    case "switch": {
      const chosen = [...new Set([...Object.values(step.cases), step.default])];

      return [
        [
          name,
          {
            invoke: {
              input: {
                cases: step.cases,
                default: step.default,
                key,
                reads: step.reads,
              },
              onDone: chosen.map((option) => ({
                guard: picked(option),
                target: targetOf(node.on, option),
              })),
              src: "switch",
              ...errorTransition(scope),
            },
            meta,
          },
        ],
      ];
    }

    default: {
      return absurd(step);
    }
  }
};

const compileBranch = (
  branch: Branch,
  prefix: readonly string[],
  scope: Scope
): Record<string, StateNodeJSON> =>
  Object.fromEntries(
    Object.entries(branch.states).flatMap(([name, node]) =>
      isFinal(node)
        ? [[name, { type: "final" } satisfies StateNodeJSON]]
        : compileStep(name, node, [...prefix, name], scope)
    )
  );

const compileStates = (
  states: Readonly<Record<string, StateNode>>,
  prefix: readonly string[],
  scope: Scope
): Record<string, StateNodeJSON> =>
  Object.fromEntries(
    Object.entries(states).flatMap(
      ([name, node]): (readonly [string, StateNodeJSON])[] => {
        const path = [...prefix, name];

        if (isFinal(node)) {
          return [[name, { type: "final" }]];
        }

        if (isCompound(node)) {
          const compiledState: StateNodeJSON = {
            initial: node.initial,
            on: Object.fromEntries(
              Object.entries(node.on ?? {}).map(([event, { target }]) => [
                event,
                { target },
              ])
            ),
            states: compileStates(node.states, path, scope),
          };

          const compound: StateNodeJSON =
            node.meta === undefined
              ? compiledState
              : { ...compiledState, meta: node.meta };

          const migration: (readonly [string, StateNodeJSON])[] =
            node.meta === undefined
              ? []
              : [[`${name}__amend`, { on: { [AMENDED]: { target: name } } }]];

          return [[name, compound], ...migration];
        }

        return compileStep(name, node, path, scope);
      }
    )
  );

const thinkAgentOf = ({ defaults, envelope }: Plan): AgentConfig => {
  const model = defaults.agent.model ?? envelope.models[0];

  return defaults.agent.thinking === undefined
    ? { model }
    : { model, thinking: defaults.agent.thinking };
};

export const compilePlan = (plan: Plan): CompiledMachine => ({
  id: plan.machine.id,
  initial: plan.machine.initial,
  states: compileStates(plan.machine.states, [], {
    machineId: plan.machine.id,
    onError: undefined,
    thinkAgent:
      plan.envelope.thresholds.think === undefined
        ? undefined
        : thinkAgentOf(plan),
    thinkThreshold: plan.envelope.thresholds.think,
  }),
  version: String(plan.version),
});

export interface Ask {
  readonly criteria?: Criteria;
  readonly key: string;
  readonly options: readonly string[];
  readonly question: string;
}

export type NodeFact =
  | { readonly kind: "ask"; readonly ask: Ask }
  | {
      readonly kind: "amend";
      readonly next: string;
      readonly path: readonly string[];
    }
  | {
      readonly kind: "await";
      readonly key: string;
      readonly to: string;
      readonly writes: string | null;
    }
  | { readonly kind: "fanout"; readonly cost: number }
  | { readonly kind: "migrate" };

const sibling = (path: readonly string[], name: string) =>
  [...path.slice(0, -1), name].join(".");

const stepFacts = (
  node: StepState,
  path: readonly string[]
): (readonly [string, NodeFact])[] => {
  const { step } = node.meta;
  const key = path.join(".");
  const name = path.at(-1) ?? "";

  switch (step.kind) {
    case "ask-joel": {
      return [
        [
          key,
          {
            ask: { key, options: options(node.on), question: step.question },
            kind: "ask",
          },
        ],
      ];
    }

    case "judge": {
      const asked = { key, options: options(node.on), question: step.question };

      return [
        [
          sibling(path, `${name}__joel`),
          {
            ask:
              step.criteria === undefined
                ? asked
                : { ...asked, criteria: step.criteria },
            kind: "ask",
          },
        ],
      ];
    }

    case "sketch": {
      return [
        [
          sibling(path, `${name}__amend`),
          { kind: "amend", next: step.next, path },
        ],
      ];
    }

    case "parallel": {
      const cost = Object.values(step.branches)
        .map((branch) => branchLength(branch) ?? 0)
        .reduce((sum, length) => sum + length, 0);

      const awaits = Object.entries(step.branches).flatMap(
        ([branchName, branch]) =>
          Object.entries(branch.states).flatMap(([stateName, state]) =>
            isStep(state)
              ? // oxlint-disable-next-line eslint/no-use-before-define -- branch steps are steps, whose facts include parallel branches.
                stepFacts(state, [...path, branchName, stateName])
              : []
          )
      );

      return [[key, { cost, kind: "fanout" }], ...awaits];
    }

    case "ask": {
      return [
        [
          sibling(path, `${name}${REPLY_SUFFIX}`),
          { key, kind: "await", to: step.to, writes: step.writes ?? null },
        ],
      ];
    }

    case "switch":
    case "think": {
      return [];
    }

    default: {
      return absurd(step);
    }
  }
};

const stateFacts = (
  states: Readonly<Record<string, StateNode>>,
  prefix: readonly string[]
): (readonly [string, NodeFact])[] =>
  Object.entries(states).flatMap(([name, node]) => {
    const path = [...prefix, name];

    if (isFinal(node)) {
      return [];
    }

    if (isStep(node)) {
      return stepFacts(node, path);
    }

    const migration: (readonly [string, NodeFact])[] =
      node.meta === undefined
        ? []
        : [[sibling(path, `${name}__amend`), { kind: "migrate" }]];

    return [...stateFacts(node.states, path), ...migration];
  });

export const planFacts = (plan: Plan): ReadonlyMap<string, NodeFact> =>
  new Map(stateFacts(plan.machine.states, []));
