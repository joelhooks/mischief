import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, it } from "@effect/vitest";
import { DeclaredThinking, thinkingLevels, validatePlan } from "@mischief/core";
import type { ThinkingLevel } from "@mischief/core";
import { Effect, Exit, Redacted, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { THINK_DEFAULT, gatewayThinkerOptions } from "../dist/index.js";
import type { GATEWAY_MODELS } from "../dist/index.js";

const options = gatewayThinkerOptions(
  () => Effect.succeed(new MemoryStorage()),
  {
    apiKey: Redacted.make("test-key"),
    baseUrl: "https://model-proxy.test/v1",
  }
);

const ModelName = Schema.Literals([
  "gpt-6-luna",
  "gpt-6.1-sol",
  "luna",
  "sol",
] satisfies (keyof typeof GATEWAY_MODELS)[]);

type GatewayName = typeof ModelName.Type;

const Level = Schema.Literals(thinkingLevels);

const sentBy = (name: GatewayName, level: ThinkingLevel) => {
  const ref = options.modelRefs[name];

  const model =
    ref === undefined
      ? undefined
      : options.models.getModel(ref.provider, ref.modelId);

  return model === undefined ? undefined : clampThinkingLevel(model, level);
};

const sentUnchanged = (name: GatewayName) =>
  thinkingLevels.filter((level) => sentBy(name, level) === level);

const Agent = Schema.Struct({
  model: Schema.optionalKey(ModelName),
  thinking: Schema.optionalKey(Level),
});

type AgentWorld = typeof Agent.Type;

const World = Schema.Struct({
  defaults: Agent,
  first: ModelName,
  judged: Schema.Boolean,
  maxThinking: Level,
  think: Agent,
});

type PlanWorld = typeof World.Type;

const highest = (levels: readonly (ThinkingLevel | undefined)[]) =>
  thinkingLevels[
    Math.max(
      ...levels.map((level) =>
        level === undefined ? 0 : thinkingLevels.indexOf(level)
      )
    )
  ] ?? "max";

const ceilingOf = (world: PlanWorld) =>
  highest([world.maxThinking, world.defaults.thinking, world.think.thinking]);

const capped = (level: ThinkingLevel, ceiling: ThinkingLevel) =>
  thinkingLevels.indexOf(level) > thinkingLevels.indexOf(ceiling)
    ? ceiling
    : level;

const planOf = (world: PlanWorld) => ({
  defaults: { agent: world.defaults },
  envelope: {
    maxAgents: 1,
    maxDepth: 2,
    maxSteps: 5,
    maxThinking: ceilingOf(world),
    models: [
      world.first,
      ...ModelName.literals.filter((name) => name !== world.first),
    ],
    names: [],
    thresholds: world.judged ? { judge: 0.8, think: 0.5 } : { judge: 0.8 },
  },
  id: "levels",
  machine: {
    id: "levels",
    initial: "work",
    states: {
      done: { type: "final" },
      pick: {
        meta: { step: { kind: "judge", question: "ship it?" } },
        on: { no: { target: "done" }, yes: { target: "done" } },
      },
      work: {
        meta: {
          step:
            Object.keys(world.think).length === 0
              ? { kind: "think", prompt: "go" }
              : { agent: world.think, kind: "think", prompt: "go" },
        },
        on: { done: { target: "pick" } },
      },
    },
  },
  version: 1,
});

interface Ask {
  readonly level: ThinkingLevel;
  readonly model: GatewayName;
  readonly where: string;
}

const askOf = (world: PlanWorld, agent: AgentWorld, where: string): Ask => ({
  level: agent.thinking ?? capped(THINK_DEFAULT.thinking, ceilingOf(world)),
  model: agent.model ?? world.first,
  where,
});

const asksOf = (world: PlanWorld): readonly Ask[] => {
  const merged = { ...world.defaults, ...world.think };

  return [
    askOf(world, world.defaults, "defaults.agent"),
    askOf(world, merged, "work"),
    ...(world.judged ? [askOf(world, world.defaults, "pick")] : []),
  ];
};

const declared = options.declared ?? { fallback: "low", models: {} };

const validated = (plan: ReturnType<typeof planOf>) =>
  validatePlan(plan).pipe(Effect.provideService(DeclaredThinking, declared));

const levelErrors = (plan: ReturnType<typeof planOf>) =>
  validated(plan).pipe(
    Effect.match({
      onFailure: ({ errors }) =>
        errors.filter((error) => error.includes("does not declare")),
      onSuccess: () => [],
    })
  );

it.effect.prop(
  "a plan passes exactly when every think, judge rung and defaults.agent asks a level its model sends unchanged, and each refusal lists exactly those levels",
  { world: Arbitrary.schema(World) },
  ({ world }) =>
    Effect.gen(function* property() {
      const plan = planOf(world);
      const exit = yield* Effect.exit(validated(plan));
      const errors = yield* levelErrors(plan);
      const asks = asksOf(world);

      const lowered = asks.filter(
        ({ level, model }) => sentBy(model, level) !== level
      );

      expect(Exit.isSuccess(exit)).toBe(lowered.length === 0);
      expect(errors).toHaveLength(lowered.length);

      for (const ask of lowered) {
        expect(
          errors.some(
            (error) =>
              error.startsWith(`${ask.where}: `) &&
              error.includes(
                `asks model "${ask.model}" for thinking "${ask.level}"`
              ) &&
              error.includes(
                `"${ask.model}" declares: ${sentUnchanged(ask.model).join(", ")}.`
              )
          )
        ).toBe(true);
      }
    }),
  { arbitrary: { runs: 300 } }
);

const single = (model: GatewayName, thinking: ThinkingLevel) =>
  planOf({
    defaults: {},
    first: model,
    judged: false,
    maxThinking: "max",
    think: { model, thinking },
  });

it.effect("luna at max and sol at medium pass", () =>
  Effect.gen(function* passing() {
    for (const [model, thinking] of [
      ["luna", "max"],
      ["gpt-6-luna", "xhigh"],
      ["sol", "medium"],
    ] as const) {
      expect(
        Exit.isSuccess(yield* Effect.exit(validated(single(model, thinking))))
      ).toBe(true);
    }
  })
);

it.effect(
  "a sol think at xhigh is refused with the levels sol sends and the models that send xhigh",
  () =>
    Effect.gen(function* solXhigh() {
      const refused = yield* Effect.flip(validated(single("sol", "xhigh")));

      expect(refused.errors).toStrictEqual([
        'work: this think asks model "sol" for thinking "xhigh", which "sol" does not declare, so the provider would silently get a lower level. "sol" declares: off, minimal, low, medium, high. Fix: set its agent.thinking to one of those, or set its agent.model to a model that declares "xhigh" (gpt-6-luna, luna)',
      ]);
    })
);
