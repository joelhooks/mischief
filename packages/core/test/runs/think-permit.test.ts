import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunStore, withinRun } from "../../src/runs/run-store.js";
import type { RunState } from "../../src/runs/schema.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import {
  DEFAULT_THINK_CONCURRENCY,
  THINK_CONCURRENCY_FLAG,
  ThinkConcurrency,
  thinkConcurrencyFrom,
} from "../../src/steps/think-concurrency.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const RUN = "wide";

const SPINS = 64;

const branchOf = (index: number) => ({
  initial: "think",
  states: {
    done: { type: "final" },
    think: {
      meta: {
        step: { kind: "think", prompt: `p${index}`, writes: `out_${index}` },
      },
      on: { done: { target: "done" } },
    },
  },
});

const widePlan = (width: number) => ({
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: width,
    maxDepth: 3,
    maxSteps: width + 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: `Think ${width} times at once`,
  id: "wide",
  machine: {
    id: "wide",
    initial: "fan",
    states: {
      done: { type: "final" },
      fan: {
        meta: {
          step: {
            branches: Object.fromEntries(
              Array.from({ length: width }, (_, index) => [
                `b${index}`,
                branchOf(index),
              ])
            ),
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: { done: { target: "done" } },
      },
    },
  },
});

interface Gauge {
  calls: number;
  inFlight: number;
  max: number;
  opened: boolean;
}

const countingThinker = (gauge: Gauge, wave: number) =>
  Thinker.of({
    decide: () => Effect.die("no judge in this plan"),
    elaborate: () => Effect.die("no elaborate in this plan"),
    think: ({ prompt }) =>
      Effect.gen(function* counted() {
        gauge.calls += 1;
        gauge.inFlight += 1;
        gauge.max = Math.max(gauge.max, gauge.inFlight);
        gauge.opened ||= gauge.inFlight >= wave;

        for (let spin = 0; spin < SPINS * 4 && !gauge.opened; spin += 1) {
          yield* Effect.yieldNow;
        }

        for (let spin = 0; spin < SPINS; spin += 1) {
          yield* Effect.yieldNow;
        }

        gauge.inFlight -= 1;

        return { output: `answer to ${prompt}`, tokens: 1 };
      }),
  });

const silentThinker = Thinker.of({
  decide: () => Effect.die("a replayed run asked the judge's think rung"),
  elaborate: () => Effect.die("a replayed run elaborated"),
  think: () => Effect.die("a replayed run called the model"),
});

const quiet = Layer.mergeAll(
  NodeCrypto.layer,
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

const freshGauge = (): Gauge => ({
  calls: 0,
  inFlight: 0,
  max: 0,
  opened: false,
});

const driveWide = (width: number, cap: number | null) =>
  Effect.gen(function* drive() {
    const gauge = freshGauge();
    const wave = Math.min(width, cap ?? DEFAULT_THINK_CONCURRENCY);

    const made = RunHost.make.pipe(
      Effect.provide(Layer.mergeAll(quiet, Layer.fresh(RunStore.memory))),
      Effect.provideService(Thinker, countingThinker(gauge, wave))
    );

    const host = yield* cap === null
      ? made
      : made.pipe(Effect.provideService(ThinkConcurrency, cap));

    const { docs, status } = yield* host.submit(RUN, widePlan(width));

    return { docs, gauge, status };
  });

const WorldSchema = Schema.Struct({
  cap: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 1 })),
  width: Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 2 })),
});

it.effect.prop(
  "a wide parallel step never has more think calls in flight than the host's permit count, every branch still answers, and the docs match an uncapped run",
  { world: Arbitrary.schema(WorldSchema) },
  ({ world }) =>
    Effect.gen(function* capped() {
      const limited = yield* driveWide(world.width, world.cap);
      const open = yield* driveWide(world.width, world.width);

      expect(limited.gauge.max).toBeLessThanOrEqual(world.cap);
      expect(limited.gauge.calls).toBe(world.width);
      expect(limited.status).toBe("done");
      expect(open.status).toBe("done");
      expect(open.gauge.max).toBe(world.width);
      expect(limited.docs).toStrictEqual(open.docs);
      expect(
        Array.from(
          { length: world.width },
          (_, index) => limited.docs[`out_${index}`]
        )
      ).toStrictEqual(
        Array.from({ length: world.width }, (_, index) => `answer to p${index}`)
      );
    }),
  { arbitrary: { runs: 40 } }
);

it.effect(
  "a host that leaves the cap unset holds a run to twenty think calls at once",
  () =>
    Effect.gen(function* defaulted() {
      const width = DEFAULT_THINK_CONCURRENCY + 5;
      const { gauge, status } = yield* driveWide(width, null);

      expect(status).toBe("done");
      expect(gauge.calls).toBe(width);
      expect(gauge.max).toBe(DEFAULT_THINK_CONCURRENCY);
    })
);

it.effect.prop(
  "a run re-driven from a checkpoint taken before its thinks replays them from the journal, with no permit to take and no model to call",
  { world: Arbitrary.schema(WorldSchema) },
  ({ world }) =>
    Effect.gen(function* replayed() {
      const store = yield* RunStore;
      const saved: RunState[] = [];
      const gauge = freshGauge();

      const recording = RunStore.of({
        ...store,
        writeRun: (runId, state) =>
          Effect.sync(() => saved.push(state)).pipe(
            Effect.andThen(store.writeRun(runId, state))
          ),
      });

      const first = yield* RunHost.make.pipe(
        Effect.provide(quiet),
        Effect.provideService(RunStore, recording),
        Effect.provideService(
          Thinker,
          countingThinker(gauge, Math.min(world.width, world.cap))
        ),
        Effect.provideService(ThinkConcurrency, world.cap)
      );

      const recorded = yield* first.submit(RUN, widePlan(world.width));

      expect(recorded.status).toBe("done");

      const beforeThinks = saved.find(
        (state) => state.status === "running" && state.checkpoint !== null
      );

      expect(beforeThinks).toBeDefined();

      if (beforeThinks === undefined) {
        return;
      }

      yield* withinRun(store, RUN)(store.writeRun(RUN, beforeThinks));

      const second = yield* RunHost.make.pipe(
        Effect.provide(quiet),
        Effect.provideService(RunStore, store),
        Effect.provideService(Thinker, silentThinker),
        Effect.provideService(ThinkConcurrency, 0)
      );

      const replay = yield* second.advance(RUN);

      expect(replay.status).toBe("done");
      expect(replay.docs).toStrictEqual(recorded.docs);
      expect(gauge.calls).toBe(world.width);
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 20 } }
);

it.effect.prop(
  `${THINK_CONCURRENCY_FLAG} takes any positive whole number as the permit count`,
  {
    given: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 100_000, minimum: 1 }))
    ),
  },
  ({ given }) =>
    Effect.sync(() => {
      expect(thinkConcurrencyFrom(` ${given} `)).toStrictEqual(
        Result.succeed(given)
      );
    })
);

it.effect.prop(
  `${THINK_CONCURRENCY_FLAG} left empty means twenty`,
  { given: Arbitrary.schema(Schema.Literals(["", " ", "\t"])) },
  ({ given }) =>
    Effect.sync(() => {
      expect(thinkConcurrencyFrom(given)).toStrictEqual(
        Result.succeed(DEFAULT_THINK_CONCURRENCY)
      );
    })
);

const RefusedSchema = Schema.Union([
  Schema.Literals([
    "abc",
    "1.5",
    "2e3",
    "0x10",
    "-0",
    "Infinity",
    "20 permits",
  ]),
  Schema.Int.check(Schema.isBetween({ maximum: 0, minimum: -1000 })),
]);

it.effect.prop(
  `${THINK_CONCURRENCY_FLAG} refuses anything but a positive whole number, naming the variable and the value`,
  { given: Arbitrary.schema(RefusedSchema) },
  ({ given }) =>
    Effect.sync(() => {
      const text = String(given);
      const parsed = thinkConcurrencyFrom(text);

      expect(Result.isFailure(parsed)).toBe(true);
      expect(Result.isFailure(parsed) && parsed.failure.message).toContain(
        `${THINK_CONCURRENCY_FLAG}="${text}" is refused`
      );
    })
);
