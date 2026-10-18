import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";

import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { ProviderUnavailable } from "../../src/steps/provider-unavailable.js";
import { ThinkConcurrency } from "../../src/steps/think-concurrency.js";
import { Thinker } from "../../src/steps/thinker.js";

const branch = (name: string) => ({
  initial: "draft",
  states: {
    done: { type: "final" },
    draft: {
      meta: { step: { kind: "think", prompt: name, writes: name } },
      on: { done: { target: "done" } },
    },
  },
});

const plan = {
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: 3,
    maxDepth: 3,
    maxSteps: 20,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Resume mixed parallel holds without bypassing permits",
  id: "fan",
  machine: {
    id: "fan",
    initial: "fan",
    states: {
      done: { type: "final" },
      fan: {
        meta: {
          step: {
            branches: {
              alpha: branch("alpha"),
              beta: branch("beta"),
              human: branch("human"),
            },
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: { done: { target: "done" } },
      },
    },
  },
};

it.effect.prop(
  "automatic wakes retry only due parallel branches, leave a billing branch held, and every retry still takes the run's think permit",
  { hint: Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 })) },
  ({ hint }) =>
    Effect.gen(function* parallelHolds() {
      const counts = new Map<string, number>();
      const world = { active: 0, manual: false, peak: 0 };

      const host = yield* RunHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Judge.unwired,
            Mail.unwired,
            Layer.succeed(ThinkConcurrency, 1),
            Layer.succeed(Operator, Operator.of({ notify: () => Effect.void })),
            Layer.succeed(
              Thinker,
              Thinker.of({
                decide: () => Effect.die("unused"),
                elaborate: () => Effect.die("unused"),
                think: ({ key, prompt }) =>
                  Effect.gen(function* proxyCall() {
                    const count = (counts.get(prompt) ?? 0) + 1;

                    counts.set(prompt, count);
                    world.active += 1;
                    world.peak = Math.max(world.active, world.peak);
                    yield* Effect.yieldNow;

                    if (world.manual || (prompt !== "human" && count > 1)) {
                      return { output: "drafted", tokens: 1 };
                    }

                    return yield* new ProviderUnavailable({
                      cause: prompt === "human" ? "billing" : "busy",
                      key,
                      provider: "proxy/shared",
                      retryAfter:
                        (yield* Clock.currentTimeMillis) +
                        (prompt === "alpha" ? hint : hint + 40_000),
                      status: 429,
                    });
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        world.active -= 1;
                      })
                    )
                  ),
              })
            )
          )
        )
      );

      const read = RunStore.use((store) => store.readRun("fan")).pipe(
        Effect.map(Option.getOrThrow)
      );

      yield* TestClock.setTime(0);
      yield* host.submit("fan", plan);

      for (let wave = 0; wave < 2; wave += 1) {
        const before = yield* read;

        const schedules = before.held.flatMap(({ resumeAfter }) =>
          resumeAfter === null ? [] : [resumeAfter]
        );

        const at = Math.min(...schedules);
        const countsBefore = new Map(counts);

        yield* TestClock.setTime(at);
        yield* host.advance("fan");

        for (const held of before.held) {
          const name = held.key.includes("alpha") ? "alpha" : "beta";

          if (held.resumeAfter !== null && held.resumeAfter > at) {
            expect(counts.get(name)).toBe(countsBefore.get(name));
          }
        }

        expect(counts.get("human")).toBe(1);
      }

      expect(Object.fromEntries(counts)).toStrictEqual({
        alpha: 2,
        beta: 2,
        human: 1,
      });
      expect((yield* read).held.map(({ cause }) => cause)).toStrictEqual([
        "billing",
      ]);
      expect(world.peak).toBe(1);

      world.manual = true;
      expect((yield* host.resume("fan")).status).toBe("done");
      expect(counts.get("human")).toBe(2);
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 20 } }
);
