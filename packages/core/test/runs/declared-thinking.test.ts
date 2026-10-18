import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { DeclaredThinking } from "../../src/plans/declared-thinking.js";
import type { ThinkingLevel } from "../../src/plans/declared-thinking.js";
import { thinkingLevels } from "../../src/plans/schema.js";
import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";

const SOL: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

const declaration = {
  fallback: "medium",
  models: { luna: thinkingLevels, sol: SOL },
} as const;

const planOf = (
  model: "luna" | "sol",
  thinking: ThinkingLevel,
  prompt: string
) => ({
  defaults: { agent: {} },
  envelope: {
    maxAgents: 1,
    maxDepth: 2,
    maxSteps: 10,
    maxThinking: "max",
    models: ["sol", "luna"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  id: "levels",
  machine: {
    id: "levels",
    initial: "gate",
    states: {
      done: { type: "final" },
      gate: {
        meta: { step: { kind: "ask-joel", question: "start?" } },
        on: { go: { target: "work" }, stop: { target: "done" } },
      },
      work: {
        meta: { step: { agent: { model, thinking }, kind: "think", prompt } },
        on: { done: { target: "done" } },
      },
    },
  },
  version: 1,
});

const world = () => {
  const asked: string[] = [];

  const layer = Layer.mergeAll(
    NodeCrypto.layer,
    RunStore.memory,
    Layer.succeed(
      Thinker,
      Thinker.of({
        decide: () => Effect.die("unused"),
        elaborate: () => Effect.die("unused"),
        think: ({ agent }) =>
          Effect.sync(() => {
            asked.push(`${agent.model}/${agent.thinking}`);

            return { output: "ok", tokens: 1 };
          }),
      })
    ),
    Layer.succeed(Judge, Judge.of({ choose: () => Effect.die("unused") })),
    Layer.succeed(
      Mail,
      Mail.of({
        seal: () => Effect.die("unused"),
        send: () => Effect.die("unused"),
      })
    ),
    Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
  );

  return { asked, layer };
};

const strictHost = RunHost.make.pipe(
  Effect.provideService(DeclaredThinking, declaration)
);

it.effect.prop(
  "a host that declares levels refuses an undeclared one at submit and revise with the same reason, and replays a run stored before it unchanged",
  {
    model: Arbitrary.schema(Schema.Literals(["luna", "sol"])),
    thinking: Arbitrary.schema(Schema.Literals(thinkingLevels)),
  },
  ({ model, thinking }) => {
    const { asked, layer } = world();

    return Effect.gen(function* property() {
      const legacy = yield* RunHost.make;

      yield* legacy.submit("stored", planOf(model, thinking, "go"));
      yield* legacy.submit("revised", planOf(model, thinking, "go"));

      const strict = yield* strictHost;
      const declared = declaration.models[model].includes(thinking);

      const submitted = yield* Effect.exit(
        strict.submit("fresh", planOf(model, thinking, "go"))
      );

      expect(Exit.isSuccess(submitted)).toBe(declared);

      const revised = yield* Effect.exit(
        strict.revise("revised", planOf(model, thinking, "go again"), false)
      );

      expect(Exit.isSuccess(revised)).toBe(declared);

      if (!declared) {
        const reason = `work: this think asks model "${model}" for thinking "${thinking}", which "${model}" does not declare`;

        expect(String(submitted)).toContain(reason);
        expect(String(revised)).toContain(reason);
      }

      const replayed = yield* strict.answer("stored", "go");

      expect(replayed.status).toBe("done");
      expect(asked).toStrictEqual([`${model}/${thinking}`]);
    }).pipe(Effect.provide(layer));
  },
  { arbitrary: { runs: 60 } }
);
