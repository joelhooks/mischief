import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { EnabledStepKinds } from "../../src/plans/step-kinds.js";
import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import {
  CALL_CONCURRENCY_FLAG,
  CallConcurrency,
  DEFAULT_CALL_CONCURRENCY,
  callConcurrencyFrom,
} from "../../src/steps/call-concurrency.js";
import { CallRegistry, callable } from "../../src/steps/call-registry.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { ThinkConcurrency } from "../../src/steps/think-concurrency.js";
import { Thinker } from "../../src/steps/thinker.js";

const quiet = Layer.mergeAll(
  NodeCrypto.layer,
  Judge.unwired,
  Mail.unwired,
  Thinker.unwired,
  Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
);

const planOf = (width: number) => ({
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: width + 10,
    maxThinking: "low",
    models: ["m"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  id: "wide-calls",
  machine: {
    id: "wide-calls",
    initial: "fan",
    states: {
      end: { type: "final" },
      fan: {
        meta: {
          step: {
            branches: Object.fromEntries(
              Array.from({ length: width }, (_, index) => [
                `b${index}`,
                {
                  initial: "call",
                  states: {
                    call: {
                      meta: {
                        step: {
                          capability: "echo",
                          input: index,
                          kind: "call",
                          writes: `d${index}`,
                        },
                      },
                      on: { done: { target: "end" } },
                    },
                    end: { type: "final" },
                  },
                },
              ])
            ),
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: { done: { target: "end" } },
      },
    },
  },
});

const drive = (width: number, cap: number | null) =>
  Effect.gen(function* wideCalls() {
    const opened = yield* Deferred.make<boolean>();
    const gauge = { calls: 0, inFlight: 0, max: 0 };
    const wave = Math.min(width, cap ?? DEFAULT_CALL_CONCURRENCY);

    const echo = callable({
      input: Schema.Int,
      output: Schema.Int,
      run: (value) =>
        Effect.gen(function* counted() {
          gauge.calls += 1;
          gauge.inFlight += 1;
          gauge.max = Math.max(gauge.max, gauge.inFlight);

          if (gauge.inFlight >= wave) {
            yield* Deferred.succeed(opened, true);
          }

          yield* Deferred.await(opened);
          yield* Effect.yieldNow;
          gauge.inFlight -= 1;

          return value;
        }),
    });

    const made = RunHost.make.pipe(
      Effect.provide(quiet),
      Effect.provideService(CallRegistry, new Map([["echo", echo]])),
      Effect.provideService(EnabledStepKinds, new Set(["call"])),
      Effect.provideService(ThinkConcurrency, 0)
    );

    const host = yield* cap === null
      ? made
      : made.pipe(Effect.provideService(CallConcurrency, cap));

    const report = yield* host.submit("wide", planOf(width));
    const before = gauge.calls;
    expect(yield* host.advance("wide")).toStrictEqual(report);
    expect(gauge.calls).toBe(before);

    return { gauge, report };
  }).pipe(Effect.provide(Layer.fresh(RunStore.memory)));

const World = Schema.Struct({
  cap: Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 1 })),
  width: Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 2 })),
});

it.effect.prop(
  "parallel calls use their own permits, never exceed the cap, and write the same docs as uncapped calls",
  { world: Arbitrary.schema(World) },
  ({ world }) =>
    Effect.gen(function* capped() {
      const limited = yield* drive(world.width, world.cap);
      const open = yield* drive(world.width, world.width);
      expect(limited.gauge.calls).toBe(world.width);
      expect(limited.gauge.max).toBeLessThanOrEqual(world.cap);
      expect(open.gauge.max).toBe(world.width);
      expect(limited.report.status).toBe("done");
      expect(open.report.status).toBe("done");

      const expected = Object.fromEntries(
        Array.from({ length: world.width }, (_, index) => [`d${index}`, index])
      );

      expect(limited.report.docs).toStrictEqual(expected);
      expect(limited.report.docs).toStrictEqual(open.report.docs);
    }),
  { arbitrary: { runs: 40 } }
);

it.effect("an unset call permit count admits sixteen concurrent calls", () =>
  Effect.gen(function* defaulted() {
    const { gauge, report } = yield* drive(DEFAULT_CALL_CONCURRENCY + 5, null);
    expect(report.status).toBe("done");
    expect(gauge.max).toBe(DEFAULT_CALL_CONCURRENCY);
  })
);

it.effect.prop(
  `${CALL_CONCURRENCY_FLAG} accepts positive whole numbers and refuses other values`,
  { text: Arbitrary.schema(Schema.String) },
  ({ text }) =>
    Effect.sync(() => {
      const trimmed = text.trim();
      const result = callConcurrencyFrom(text);

      if (trimmed === "") {
        expect(result).toStrictEqual(Result.succeed(DEFAULT_CALL_CONCURRENCY));
      } else if (
        /^[1-9]\d*$/u.test(trimmed) &&
        Number.isSafeInteger(Number(trimmed))
      ) {
        expect(result).toStrictEqual(Result.succeed(Number(trimmed)));
      } else {
        expect(Result.isFailure(result) && result.failure.message).toContain(
          `${CALL_CONCURRENCY_FLAG}="${trimmed}" is refused`
        );
      }
    })
);

it.effect.prop(
  "a configured call permit count is preserved",
  {
    cap: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 }))
    ),
  },
  ({ cap }) =>
    Effect.sync(() => {
      expect(callConcurrencyFrom(String(cap))).toStrictEqual(
        Result.succeed(cap)
      );
      expect(callConcurrencyFrom("")).toStrictEqual(Result.succeed(16));
    })
);
