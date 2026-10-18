import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const STEPS = ["draft", "review", "polish", "ship"] as const;

const thinkThen = (name: string, target: string) => ({
  meta: { step: { kind: "think", prompt: name, writes: name } },
  on: { done: { target } },
});

const chainOf = (length: number, goal: string) => {
  const names = STEPS.slice(0, length);

  return {
    defaults: { agent: {} },
    envelope: {
      maxAgents: 4,
      maxDepth: 3,
      maxSteps: 40,
      maxThinking: "low",
      models: ["sol"],
      names: [],
      thresholds: { judge: 0.8 },
    },
    goal,
    id: "line",
    machine: {
      id: "line",
      initial: "draft",
      states: {
        ...Object.fromEntries(
          names.map((name, index) => [
            name,
            thinkThen(name, names[index + 1] ?? "end"),
          ])
        ),
        end: { type: "final" },
      },
    },
  };
};

const services = Layer.mergeAll(
  NodeCrypto.layer,
  RunStore.memory,
  Layer.succeed(
    Thinker,
    Thinker.of({
      decide: () => Effect.die("unused"),
      elaborate: () => Effect.die("unused"),
      think: ({ prompt }) =>
        Effect.succeed({
          cacheRead: prompt.length * 7,
          output: `${prompt} written`,
          tokens: prompt.length,
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

it.effect.prop(
  "readRun returns the run's current plan and every step's journal line, with its tokens and cache reads, in the order the steps ran",
  {
    length: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 }))
    ),
    revised: Arbitrary.schema(Schema.Boolean),
  },
  ({ length, revised }) =>
    Effect.gen(function* property() {
      const host = yield* RunHost.make;

      yield* host.submit("run", chainOf(length, "first goal"));

      if (revised) {
        yield* host.revise("run", chainOf(length, "second goal"), false);
      }

      const record = yield* host.read("run");

      expect(record.runId).toBe("run");
      expect(record.planVersion).toBe(revised ? 2 : 1);
      expect(record.plan.version).toBe(record.planVersion);
      expect(record.plan.goal).toBe(revised ? "second goal" : "first goal");

      const steps = record.journal.filter(({ key }) =>
        key.startsWith("logic:")
      );

      expect(steps.map(({ key }) => key.split(".").at(-1))).toEqual(
        STEPS.slice(0, length).map((name) => `${name}#1`)
      );
      expect(steps.map(({ entry }) => entry)).toEqual(
        STEPS.slice(0, length).map((name) => ({
          cacheRead: name.length * 7,
          output: `${name} written`,
          tokens: name.length,
        }))
      );

      const missing = yield* Effect.exit(host.read("nobody"));

      expect(Exit.isFailure(missing) && String(missing.cause)).toContain(
        "nobody"
      );
    }).pipe(Effect.provide(services)),
  { arbitrary: { runs: 40 } }
);
