import { expect, it } from "@effect/vitest";
import {
  CallerThinkShare,
  Judge,
  Mail,
  Operator,
  RunStateSchema,
  ThinkConcurrency,
  Thinker,
} from "@mischief/core";
import { makePlanRun } from "@mischief/plan-run";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Clock, Deferred, Effect, Fiber, Layer, Queue, Schema } from "effect";
import { TestClock } from "effect/testing";

import { callerThinkPermit } from "../src/caller-think-permit.js";
import { callerThinkLedger } from "../src/caller-thinks.js";

const branch = (prompt: string) => ({
  initial: "think",
  states: {
    done: { type: "final" },
    think: {
      meta: { step: { kind: "think", prompt, writes: prompt } },
      on: { done: { target: "done" } },
    },
  },
});

const planFor = (branches: number) => ({
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: branches + 1,
    maxDepth: 3,
    maxSteps: 30,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Only running thinks occupy caller capacity",
  id: "ownership",
  machine:
    branches === 1
      ? { id: "ownership", ...branch("work0") }
      : {
          id: "ownership",
          initial: "fan",
          states: {
            done: { type: "final" },
            fan: {
              meta: {
                step: {
                  branches: Object.fromEntries(
                    Array.from({ length: branches }, (_, index) => [
                      `branch${index}`,
                      branch(`work${index}`),
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

interface AlarmLog {
  pending: number | null;
}

const ownershipWorld = Effect.fnUntraced(function* ownershipWorld(options: {
  readonly durationMs: number;
  readonly permits: number;
  readonly share: number;
  readonly thinker: Thinker["Service"];
}) {
  const clock = yield* Clock.Clock;
  const storage = nodeSqlStorage(":memory:");
  const callerStorage = nodeSqlStorage(":memory:");
  const ledger = callerThinkLedger(callerStorage);

  const acquisitions = yield* Queue.unbounded<{
    readonly acquired: boolean;
    readonly id: string;
  }>();

  const observed = { peak: 0 };

  const count = () =>
    Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(
      callerStorage.sql
        .exec("SELECT COUNT(*) AS count FROM caller_think_leases")
        .toArray()[0]
    ).count;

  const services = Layer.mergeAll(
    Judge.unwired,
    Mail.unwired,
    Layer.succeed(Clock.Clock, clock),
    Layer.succeed(ThinkConcurrency, options.permits),
    Layer.succeed(Thinker, options.thinker),
    Layer.succeed(Operator, Operator.of({ notify: () => Effect.void })),
    Layer.succeed(
      CallerThinkShare,
      callerThinkPermit({
        acquire: (step, id) =>
          Effect.gen(function* takeLease() {
            const now = yield* Clock.currentTimeMillis;

            const result = ledger.acquire({
              caller: "caller",
              id,
              key: step.key,
              now,
              objectName: `caller/${step.runId}`,
              share: options.share,
              to: ["caller", "desk"],
              ttlMs: 10_000,
            });

            observed.peak = Math.max(observed.peak, count());
            yield* Queue.offer(acquisitions, { acquired: result.acquired, id });

            return { ...result, share: options.share };
          }),
        durationMs: options.durationMs,
        release: (id) =>
          Effect.sync(() => {
            ledger.release(id);
          }),
      })
    )
  );

  const alarms: AlarmLog = { pending: null };

  const host = () =>
    makePlanRun({
      alarms: {
        // @effect-diagnostics-next-line asyncFunction:off -- The alarm port requires a Promise callback; it only mutates this fixture's local log.
        clear: async () => {
          alarms.pending = null;
          await Promise.resolve();
        },
        // @effect-diagnostics-next-line asyncFunction:off -- The alarm port requires a Promise callback; it only reads this fixture's local log.
        get: async () => await Promise.resolve(alarms.pending),
        // @effect-diagnostics-next-line asyncFunction:off -- The alarm port requires a Promise callback; it only mutates this fixture's local log.
        set: async (at: number) => {
          alarms.pending = at;
          await Promise.resolve();
        },
      },
      guardMs: 30,
      services,
      storage,
    });

  const first = host();

  const submit = (branches: number) =>
    Effect.promise(
      first.fetch.bind(
        first,
        new Request("http://plan-run/submitPlan", {
          body: JSON.stringify({
            plan: planFor(branches),
            runId: "ownership",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      )
    ).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          expect(response.status).toBe(200);
        })
      )
    );

  const state = () =>
    Schema.decodeUnknownSync(Schema.fromJsonString(RunStateSchema))(
      storage.sql
        .exec("SELECT state FROM mischief_runs WHERE run_id = 'ownership'")
        .toArray()[0]?.state
    );

  return { acquisitions, count, first, host, observed, state, submit };
});

it.effect.prop(
  "queued branches occupy no caller leases and receive a full leased-work deadline after their per-run permit",
  {
    extra: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
    permits: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
    workMs: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 2 })),
  },
  ({ extra, permits, workMs }) =>
    Effect.gen(function* queuedOwnership() {
      yield* TestClock.setTime(0);
      const started = yield* Queue.unbounded<Deferred.Deferred<boolean>>();
      const calls = { count: 0 };
      const branches = permits + extra;

      const world = yield* ownershipWorld({
        durationMs: workMs + 1,
        permits,
        share: branches,
        thinker: Thinker.of({
          decide: () => Effect.die("unused"),
          elaborate: () => Effect.die("unused"),
          think: () =>
            Effect.gen(function* work() {
              calls.count += 1;
              const finish = yield* Deferred.make<boolean>();
              yield* Queue.offer(started, finish);
              yield* Deferred.await(finish);

              return { output: "done", tokens: 1 };
            }),
        }),
      });

      yield* world.submit(branches);

      const driving = yield* Effect.promise(world.first.alarm).pipe(
        Effect.forkChild
      );

      for (let offset = 0; offset < branches; offset += permits) {
        const running = yield* Effect.forEach(
          Array.from({ length: Math.min(permits, branches - offset) }),
          () => Queue.take(started)
        );

        yield* TestClock.adjust(workMs);
        expect(world.observed.peak).toBeLessThanOrEqual(permits);

        for (const finish of running) {
          yield* Deferred.succeed(finish, true);
        }
      }

      yield* Fiber.join(driving);
      expect(world.observed.peak).toBeLessThanOrEqual(permits);
      expect(world.state().status).toBe("done");
      expect(calls.count).toBe(branches);
      expect(world.count()).toBe(0);
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 15 } }
);

it.effect.prop(
  "interrupting and replacing a run host reclaims its existing think lease instead of counting a ghost until expiry",
  {
    share: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 2 })),
  },
  ({ share }) =>
    Effect.gen(function* reclaimedOwnership() {
      yield* TestClock.setTime(0);
      const started = yield* Deferred.make<boolean>();
      const finish = yield* Deferred.make<boolean>();

      const world = yield* ownershipWorld({
        durationMs: 100,
        permits: 1,
        share,
        thinker: Thinker.of({
          decide: () => Effect.die("unused"),
          elaborate: () => Effect.die("unused"),
          think: () =>
            Deferred.succeed(started, true).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as({ output: "done", tokens: 1 })
            ),
        }),
      });

      yield* world.submit(1);

      const firstDrive = yield* Effect.promise(world.first.alarm).pipe(
        Effect.forkChild
      );

      yield* Deferred.await(started);
      const first = yield* Queue.take(world.acquisitions);
      expect(first.acquired).toBe(true);
      expect(world.count()).toBe(1);
      yield* Fiber.interrupt(firstDrive);
      expect(world.count()).toBe(1);
      const replacement = world.host();

      const nextDrive = yield* Effect.promise(replacement.alarm).pipe(
        Effect.forkChild
      );

      const reclaimed = yield* Queue.take(world.acquisitions);
      expect(reclaimed.acquired).toBe(true);
      expect(world.count()).toBe(1);
      expect(reclaimed.id).toBe(first.id);
      yield* Deferred.succeed(finish, true);
      yield* Fiber.join(nextDrive);
      expect(world.state().status).toBe("done");
      expect(world.count()).toBe(0);
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 15 } }
);
