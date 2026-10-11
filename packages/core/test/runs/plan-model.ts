import { Schema } from "effect";

export interface ModelCall {
  readonly docs?: string;
  readonly key: string;
  readonly kind: string;
  readonly visit: number;
}

interface ModelTransition {
  readonly target: string;
}

export interface ModelNode {
  readonly initial?: string;
  readonly meta?: { readonly step: ModelStep };
  readonly on?: Readonly<Record<string, ModelTransition>>;
  readonly states?: Readonly<Record<string, ModelNode>>;
  readonly type?: "final";
}

interface ModelBranch {
  readonly initial: string;
  readonly states: Readonly<Record<string, ModelNode>>;
}

interface ModelStep {
  readonly branches?: Readonly<Record<string, ModelBranch>>;
  readonly goal?: string;
  readonly join?: string;
  readonly kind: string;
  readonly next?: string;
  readonly prompt?: string;
  readonly reads?: readonly string[];
  readonly to?: string;
  readonly writes?: string;
}

export interface ModelAmendment {
  readonly initial: string;
  readonly states: Readonly<Record<string, ModelNode>>;
}

export interface Fixture {
  readonly amendment?: ModelAmendment;
  readonly answer?: string;
  readonly choice?: string;
  readonly confidence?: number;
  readonly fail?: boolean;
  readonly output?: string;
  readonly probs?: Readonly<Record<string, number>>;
  readonly reply?: string;
}

export type Fixtures = Readonly<Record<string, Fixture>>;

export interface ModelPlan {
  readonly envelope: {
    readonly maxSteps: number;
    readonly thresholds: { readonly judge: number; readonly think?: number };
  };
  readonly machine: {
    readonly initial: string;
    readonly states: Readonly<Record<string, ModelNode>>;
  };
}

export interface ModelOutcome {
  readonly calls: readonly ModelCall[];
  readonly docs: Readonly<Record<string, Schema.Json>>;
  readonly status: string;
  readonly transitions: number;
  readonly value: string;
}

type Move =
  | { readonly kind: "halt"; readonly status: string; readonly value: string }
  | { readonly kind: "go"; readonly path: readonly string[] };

export const toJson = Schema.decodeUnknownSync(Schema.Json);

const firstTarget = (node: ModelNode | undefined) =>
  Object.values(node?.on ?? {})[0]?.target ?? "";

const sibling = (path: readonly string[], name: string) => [
  ...path.slice(0, -1),
  name,
];

const branchLength = (branch: ModelBranch) => {
  let length = 0;

  for (
    let at = branch.initial;
    branch.states[at]?.type !== "final";
    at = firstTarget(branch.states[at])
  ) {
    length += 1;
  }

  return length;
};

const topChoice = (
  probs: Readonly<Record<string, number>>,
  threshold: number
) => {
  const [top] = Object.entries(probs).toSorted(
    (left, right) => right[1] - left[1]
  );

  return top !== undefined && top[1] >= threshold ? top[0] : undefined;
};

const confidentChoice = (
  think: Fixture | undefined,
  options: readonly string[],
  threshold: number
) =>
  think?.choice !== undefined &&
  (think.confidence ?? 0) >= threshold &&
  options.includes(think.choice)
    ? think.choice
    : undefined;

const go = (path: readonly string[]): Move => ({ kind: "go", path });

const halt = (status: string, value: string): Move => ({
  kind: "halt",
  status,
  value,
});

interface FanoutResult {
  readonly outcome: string;
  readonly used: number;
}

export const docsSeen = (docs: Readonly<Record<string, Schema.Json>>) =>
  JSON.stringify(
    Object.entries(docs).toSorted(([left], [right]) =>
      left.localeCompare(right)
    )
  );

const makeWorld = (
  plan: ModelPlan,
  fixtures: Fixtures,
  seed: Readonly<Record<string, Schema.Json>>
) => {
  const visits = new Map<string, number>();
  const answers = new Map<string, number>();
  const calls: ModelCall[] = [];
  const docs = new Map<string, Schema.Json>(Object.entries(seed));
  const states = new Map(Object.entries(plan.machine.states));
  const { maxSteps } = plan.envelope;
  const clock = { transitions: 1 };

  const nodeAt = (path: readonly string[]) => {
    const [head, ...rest] = path;
    let node = head === undefined ? undefined : states.get(head);

    for (const key of rest) {
      node = node?.states?.[key];
    }

    return node;
  };

  const enterAt = (path: readonly string[]): readonly string[] => {
    const node = nodeAt(path);

    return node?.states !== undefined && node.initial !== undefined
      ? enterAt([...path, node.initial])
      : path;
  };

  const settle = (path: readonly string[]) => {
    let current = path;

    while (nodeAt(current)?.type === "final" && current.length > 1) {
      const parent = current.slice(0, -1);

      current = enterAt(sibling(parent, firstTarget(nodeAt(parent))));
    }

    return current;
  };

  const visitOf = (key: string) => {
    const visit = (visits.get(key) ?? 0) + 1;

    visits.set(key, visit);

    return visit;
  };

  const fixtureOf = (key: string, visit: number) =>
    fixtures[`${key}#${visit}`] ?? {};

  const answer = (key: string, options: readonly string[]) => {
    const n = (answers.get(key) ?? 0) + 1;
    const reply = fixtures[`${key}#${n}:joel`]?.answer;

    if (reply !== undefined && options.includes(reply)) {
      answers.set(key, n);
    }

    return reply !== undefined && options.includes(reply) ? reply : undefined;
  };

  const writeStep = (step: ModelStep, fixture: Fixture, key: string) => {
    if (fixture.fail === true) {
      docs.set(`failed:${key}`, true);
    } else if (step.kind === "think" && step.writes !== undefined) {
      docs.set(step.writes, fixture.output ?? `(${step.prompt ?? ""})`);
    }
  };

  const onward = (path: readonly string[], target: string | undefined) =>
    go(settle(enterAt(sibling(path, target ?? ""))));

  return {
    answer,
    calls,
    clock,
    docs,
    enterAt,
    fixtureOf,
    fixtures,
    go,
    halt,
    maxSteps,
    nodeAt,
    onward,
    states,
    thinkThreshold: plan.envelope.thresholds.think,
    threshold: plan.envelope.thresholds.judge,
    visitOf,
    writeStep,
  };
};

type World = ReturnType<typeof makeWorld>;

const fanout = (
  world: World,
  step: ModelStep,
  path: readonly string[]
): FanoutResult => {
  const branches = step.branches ?? {};
  const queue: { branch: string; failed: boolean; node: ModelNode }[] = [];

  const start = (branch: string, name: string) => {
    const key = [...path, branch, name].join(".");
    const visit = world.visitOf(key);
    const node = branches[branch]?.states[name] ?? {};
    const fixture = world.fixtureOf(key, visit);
    const kind = node.meta?.step.kind ?? "";

    world.calls.push({ key, kind, visit });
    world.writeStep(node.meta?.step ?? { kind }, fixture, key);
    queue.push({ branch, failed: fixture.fail === true, node });
  };

  for (const [branch, { initial }] of Object.entries(branches)) {
    start(branch, initial);
  }

  let used = 0;

  for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
    used += 1;

    if (item.failed && step.join === "failFast") {
      return { outcome: "failed", used };
    }

    const next = firstTarget(item.node);

    if (!item.failed && branches[item.branch]?.states[next]?.type !== "final") {
      start(item.branch, next);
    }
  }

  return { outcome: "done", used };
};

const parallelMove = (
  world: World,
  node: ModelNode,
  step: ModelStep,
  path: readonly string[]
): Move => {
  const branches = Object.entries(step.branches ?? {});

  const cost = branches
    .map(([, branch]) => branchLength(branch))
    .reduce((sum, length) => sum + length, 0);

  if (world.clock.transitions + cost > world.maxSteps) {
    return world.halt(
      "envelope-exceeded",
      branches
        .map(([name, branch]) => [...path, name, branch.initial].join("."))
        .toSorted()
        .join(" | ")
    );
  }

  const { outcome, used } = fanout(world, step, path);

  world.clock.transitions += used;

  return world.onward(path, node.on?.[outcome]?.target);
};

const advanceTo = (
  world: World,
  path: readonly string[],
  target: string | undefined
) => {
  world.clock.transitions += 1;

  return world.onward(path, target);
};

const judgeMove = (
  world: World,
  node: ModelNode,
  path: readonly string[]
): Move => {
  const key = path.join(".");
  const options = Object.keys(node.on ?? {});
  const visit = world.visitOf(key);

  const seen = Object.fromEntries(
    (node.meta?.step.reads ?? []).flatMap((name) => {
      const doc = world.docs.get(name);

      return doc === undefined ? [] : [[name, doc]];
    })
  );

  world.calls.push({ docs: docsSeen(seen), key, kind: "jev", visit });

  const probs =
    world.fixtureOf(key, visit).probs ??
    Object.fromEntries(options.map((option) => [option, 1 / options.length]));

  const picked = topChoice(probs, world.threshold);

  if (picked !== undefined) {
    return advanceTo(world, path, node.on?.[picked]?.target);
  }

  const { thinkThreshold } = world;

  if (thinkThreshold !== undefined) {
    world.calls.push({ key, kind: "think-fallback", visit });
  }

  const fallback =
    thinkThreshold === undefined
      ? undefined
      : confidentChoice(
          world.fixtures[`${key}#${visit}:think`],
          options,
          thinkThreshold
        );

  if (fallback !== undefined) {
    return advanceTo(world, path, node.on?.[fallback]?.target);
  }

  world.clock.transitions += 1;

  const at = sibling(path, `${path.at(-1) ?? ""}__joel`).join(".");

  if (world.clock.transitions >= world.maxSteps) {
    return world.halt("envelope-exceeded", at);
  }

  const reply = world.answer(key, options);

  return reply === undefined
    ? world.halt("waiting-for-joel", at)
    : advanceTo(world, path, node.on?.[reply]?.target);
};

const sketchMove = (
  world: World,
  step: ModelStep,
  path: readonly string[]
): Move => {
  const key = path.join(".");
  const visit = world.visitOf(key);
  const { amendment } = world.fixtureOf(key, visit);

  world.calls.push({ key, kind: "elaborate", visit });
  world.docs.set(`__amendment:${key}`, toJson(amendment ?? null));
  world.clock.transitions += 1;

  const at = sibling(path, `${path.at(-1) ?? ""}__amend`).join(".");

  if (world.clock.transitions >= world.maxSteps) {
    return world.halt("envelope-exceeded", at);
  }

  if (amendment === undefined) {
    return world.halt("amendment-refused", at);
  }

  world.states.set(path.at(-1) ?? "", {
    initial: amendment.initial,
    on: { done: { target: step.next ?? "" } },
    states: amendment.states,
  });
  world.clock.transitions += 1;

  return world.go(world.enterAt(path));
};

const askMove = (
  world: World,
  node: ModelNode,
  step: ModelStep,
  path: readonly string[]
): Move => {
  const key = path.join(".");
  const visit = world.visitOf(key);
  const fixture = world.fixtureOf(key, visit);

  world.calls.push({ key, kind: "ask", visit });

  if (fixture.fail === true) {
    world.writeStep(step, fixture, key);

    return advanceTo(world, path, firstTarget(node));
  }

  world.docs.set(`__sent:${key}`, {
    messageId: `${key}#${visit}`,
    to: step.to ?? "",
  });
  world.clock.transitions += 1;

  const at = sibling(path, `${path.at(-1) ?? ""}__reply`).join(".");

  if (world.clock.transitions >= world.maxSteps) {
    return world.halt("envelope-exceeded", at);
  }

  if (fixture.reply === undefined) {
    return world.halt("waiting-for-reply", at);
  }

  if (step.writes !== undefined) {
    world.docs.set(step.writes, fixture.reply);
  }

  return advanceTo(world, path, firstTarget(node));
};

const stepMove = (
  world: World,
  node: ModelNode,
  step: ModelStep,
  path: readonly string[]
): Move => {
  const key = path.join(".");

  if (step.kind === "parallel") {
    return parallelMove(world, node, step, path);
  }

  if (world.clock.transitions >= world.maxSteps) {
    return world.halt("envelope-exceeded", key);
  }

  if (step.kind === "ask") {
    return askMove(world, node, step, path);
  }

  if (step.kind === "think") {
    const visit = world.visitOf(key);

    world.calls.push({ key, kind: step.kind, visit });
    world.writeStep(step, world.fixtureOf(key, visit), key);

    return advanceTo(world, path, firstTarget(node));
  }

  if (step.kind === "ask-joel") {
    const reply = world.answer(key, Object.keys(node.on ?? {}));

    return reply === undefined
      ? world.halt("waiting-for-joel", key)
      : advanceTo(world, path, node.on?.[reply]?.target);
  }

  if (step.kind === "judge") {
    return judgeMove(world, node, path);
  }

  return step.kind === "sketch"
    ? sketchMove(world, step, path)
    : advanceTo(world, path, "");
};

export const simulate = (
  plan: ModelPlan,
  fixtures: Fixtures,
  seed: Readonly<Record<string, Schema.Json>> = {}
): ModelOutcome => {
  const world = makeWorld(plan, fixtures, seed);

  let move = world.go(world.enterAt([plan.machine.initial]));

  while (move.kind === "go") {
    const { path } = move;
    const node = world.nodeAt(path);

    move =
      node?.type === "final" || node?.meta === undefined
        ? world.halt("done", path.join("."))
        : stepMove(world, node, node.meta.step, path);
  }

  return {
    calls: world.calls,
    docs: Object.fromEntries(world.docs),
    status: move.status,
    transitions: world.clock.transitions,
    value: move.value,
  };
};
