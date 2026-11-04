import { expect, it } from "@effect/vitest";
import {
  CallerThinkShare,
  Judge,
  Mail,
  Operator,
  ProviderResume,
  ProviderUnavailable,
  RunStateSchema,
  StepFailed,
  Thinker,
} from "@mischief/core";
import { makePlanRun } from "@mischief/plan-run";
import type { PlanRun } from "@mischief/plan-run";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Clock, Deferred, Effect, Fiber, Layer, Random, Schema } from "effect";
import { flow, identity } from "effect/Function";
import { TestClock } from "effect/testing";

import { callerThinkPermit } from "../src/caller-think-permit.js";
import { callerThinkLedger } from "../src/caller-thinks.js";

interface AlarmLog {
  pending: number | null;
  sets: number;
}

const alarmsFor = (log: AlarmLog) => ({
  clear: Effect.fnUntraced(function* clearAlarm() {
    yield* Effect.sync(() => {
      log.pending = null;
    });
  }, Effect.runPromise),
  get: Effect.fnUntraced(function* getAlarm() {
    return yield* Effect.sync(() => log.pending);
  }, Effect.runPromise),
  set: Effect.fnUntraced(
    function* setAlarm(at: number) {
      yield* Effect.sync(() => {
        log.pending = at;
        log.sets += 1;
      });
    },
    flow(identity<Effect.Effect<void>>, Effect.runPromise)
  ),
});

const call = (run: PlanRun, capability: string, body: Schema.Json) =>
  Effect.promise(
    run.fetch.bind(
      run,
      new Request(`http://plan-run/${capability}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    )
  );

const callAndDrive = (run: PlanRun, capability: string, body: Schema.Json) =>
  call(run, capability, body).pipe(
    Effect.tap((response) =>
      Effect.sync(() => {
        expect(response.status).toBe(200);
      })
    ),
    Effect.andThen(Effect.promise(run.alarm))
  );

const plan = {
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: 1,
    maxDepth: 2,
    maxSteps: 20,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Every caller keeps a share of model capacity",
  id: "fair",
  machine: {
    id: "fair",
    initial: "think",
    states: {
      done: { type: "final" },
      think: {
        meta: { step: { kind: "think", prompt: "work", writes: "work" } },
        on: { done: { target: "done" } },
      },
    },
  },
};

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

const decodeState = Schema.decodeUnknownSync(
  Schema.fromJsonString(RunStateSchema)
);

it.effect.prop(
  "caller A at its share waits without refusal or consuming retry attempts while B proceeds, and completion returns every lease before expiry",
  {
    retries: Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 7 })),
    share: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
  },
  ({ retries, share }) =>
    Effect.gen(function* fairAcrossRuns() {
      yield* TestClock.setTime(0);
      const clock = yield* Clock.Clock;

      const ledgers = {
        a: callerThinkLedger(nodeSqlStorage(":memory:")),
        b: callerThinkLedger(nodeSqlStorage(":memory:")),
      };

      const finish = yield* Deferred.make<boolean>();
      const world = { calls: 0, notices: 0, releases: 0 };

      const hostFor = (
        caller: "a" | "b",
        runId: string,
        parked: boolean,
        started: Deferred.Deferred<boolean>
      ) => {
        const storage = nodeSqlStorage(":memory:");
        const alarms: AlarmLog = { pending: null, sets: 0 };

        const services = Layer.mergeAll(
          Judge.unwired,
          Mail.unwired,
          Layer.succeed(Clock.Clock, clock),
          Layer.succeed(ProviderResume, { attempts: 0, baseMs: 10, capMs: 10 }),
          Layer.succeed(
            CallerThinkShare,
            callerThinkPermit({
              acquire: (step, id) =>
                Clock.currentTimeMillis.pipe(
                  Effect.map((now) => ({
                    ...ledgers[caller].acquire({
                      caller,
                      id,
                      key: step.key,
                      now,
                      objectName: `${caller}/${runId}`,
                      share,
                      to: [caller, "desk"],
                      ttlMs: 100_000,
                    }),
                    share,
                  }))
                ),
              durationMs: 90_000,
              release: (id) =>
                Effect.sync(() => {
                  ledgers[caller].release(id);
                  world.releases += 1;
                }),
            })
          ),
          Layer.succeed(
            Operator,
            Operator.of({
              holdAlarm: () =>
                Effect.sync(() => {
                  world.notices += 1;
                }),
              notify: () => Effect.void,
            })
          ),
          Layer.succeed(
            Thinker,
            Thinker.of({
              decide: () => Effect.die("unused"),
              elaborate: () => Effect.die("unused"),
              think: () =>
                Effect.gen(function* thinking() {
                  world.calls += 1;
                  yield* Deferred.succeed(started, true);

                  if (parked) {
                    yield* Deferred.await(finish);
                  }

                  return { output: "done", tokens: 1 };
                }),
            })
          )
        );

        const host = makePlanRun({
          alarms: alarmsFor(alarms),
          guardMs: 30,
          services,
          storage,
        });

        const state = () =>
          decodeState(
            storage.sql
              .exec("SELECT state FROM mischief_runs WHERE run_id = ?", runId)
              .toArray()[0]?.state
          );

        return { alarms, host, state, storage };
      };

      const active = [];

      for (let index = 0; index < share; index += 1) {
        const started = yield* Deferred.make<boolean>();
        const runId = `active-${index}`;
        const run = hostFor("a", runId, true, started);

        yield* call(run.host, "submitPlan", { plan, runId });

        const fiber = yield* Effect.promise(run.host.alarm).pipe(
          Effect.forkChild
        );

        yield* Deferred.await(started);
        active.push({ fiber, run, runId });
      }

      const waiting = hostFor(
        "a",
        "waiting",
        false,
        yield* Deferred.make<boolean>()
      );

      yield* callAndDrive(waiting.host, "submitPlan", {
        plan,
        runId: "waiting",
      });
      expect(waiting.state().status).toBe("waiting-for-provider");
      expect(waiting.state().held[0]?.error).toContain(`share of ${share}`);
      expect(waiting.alarms.pending).toBe(10);
      expect(world.calls).toBe(share);

      const other = hostFor(
        "b",
        "other",
        false,
        yield* Deferred.make<boolean>()
      );

      yield* callAndDrive(other.host, "submitPlan", { plan, runId: "other" });
      expect(other.state().status).toBe("done");
      expect(world.calls).toBe(share + 1);
      expect(world.releases).toBe(1);

      for (let retry = 0; retry < retries; retry += 1) {
        yield* TestClock.setTime((retry + 1) * 10);
        yield* Effect.promise(waiting.host.alarm);
        expect(waiting.state().status).toBe("waiting-for-provider");
        expect(waiting.state().resumeAttempts).toBe(0);
        expect(waiting.state().callerShareWaits).toBe(retry + 2);
        expect(
          waiting.storage.sql
            .exec(
              "SELECT key FROM mischief_journal WHERE key LIKE 'think-attempt:%'"
            )
            .toArray()
        ).toHaveLength(0);
        expect(waiting.alarms.pending).toBe((retry + 2) * 10);
      }

      expect(world.notices).toBe(0);
      expect(world.calls).toBe(share + 1);

      yield* Deferred.succeed(finish, true);

      for (const running of active) {
        yield* Fiber.join(running.fiber);
        expect(running.run.state().status).toBe("done");
      }

      expect(world.releases).toBe(share + 1);

      yield* TestClock.setTime((retries + 1) * 10);
      yield* Effect.promise(waiting.host.alarm);
      expect(waiting.state().status).toBe("done");
      expect(world.releases).toBe(share + 2);
      expect(waiting.alarms.pending).toBeNull();
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 15 } }
);

it.effect.prop(
  "leased deadlines abort then wait for idle before returning capacity; drive loss never aborts or returns a still-running lease, and an unconfirmed abort expires instead",
  {
    duration: Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: 1 })),
    mode: Schema.Literals(["deadline", "drive-loss", "abort-failure"]),
  },
  ({ mode, duration }) =>
    Effect.gen(function* leasedLifetime() {
      yield* TestClock.setTime(0);
      const clock = yield* Clock.Clock;
      const started = yield* Deferred.make<boolean>();
      const aborting = yield* Deferred.make<boolean>();
      const idle = yield* Deferred.make<boolean>();
      const events: string[] = [];
      const storage = nodeSqlStorage(":memory:");
      const alarms: AlarmLog = { pending: null, sets: 0 };

      const host = makePlanRun({
        alarms: alarmsFor(alarms),
        guardMs: 30,
        services: Layer.mergeAll(
          Judge.unwired,
          Mail.unwired,
          Layer.succeed(Clock.Clock, clock),
          Layer.succeed(
            CallerThinkShare,
            callerThinkPermit({
              acquire: () => Effect.succeed({ acquired: true, share: 1 }),
              durationMs: duration,
              release: () =>
                Effect.sync(() => {
                  events.push("release");
                }),
            })
          ),
          Layer.succeed(Operator, Operator.of({ notify: () => Effect.void })),
          Layer.succeed(
            Thinker,
            Thinker.of({
              abort: ({ key }) =>
                Effect.gen(function* abortConversation() {
                  events.push("abort");
                  yield* Deferred.succeed(aborting, true);
                  yield* Deferred.await(idle);

                  if (mode === "abort-failure") {
                    return yield* new StepFailed({
                      key,
                      reason: "idle could not be confirmed",
                    });
                  }

                  events.push("idle");

                  return yield* Effect.void;
                }),
              decide: () => Effect.die("unused"),
              elaborate: () => Effect.die("unused"),
              think: () =>
                Deferred.succeed(started, true).pipe(
                  Effect.andThen(Effect.never)
                ),
            })
          )
        ),
        storage,
      });

      yield* call(host, "submitPlan", { plan, runId: "lifetime" });
      const driving = yield* Effect.promise(host.alarm).pipe(Effect.forkChild);

      yield* Deferred.await(started);

      if (mode === "drive-loss") {
        yield* Deferred.succeed(idle, true);
        yield* Fiber.interrupt(driving);
        expect(events).toEqual([]);

        return;
      }

      yield* TestClock.adjust(duration);
      yield* Deferred.await(aborting);
      expect(events).toEqual(["abort"]);
      yield* Deferred.succeed(idle, true);
      yield* Fiber.join(driving);
      expect(events).toEqual(
        mode === "abort-failure" ? ["abort"] : ["abort", "idle", "release"]
      );

      const state = decodeState(
        storage.sql
          .exec("SELECT state FROM mischief_runs WHERE run_id = 'lifetime'")
          .toArray()[0]?.state
      );

      expect(state.status).toBe("waiting-for-provider");
      expect(state.resumeAttempts).toBe(0);
      expect(state.callerShareWaits).toBe(1);
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 15 } }
);

it.effect.prop(
  "capped providers neither spin caller-share alarms nor lose a provider notice after a share wait",
  {
    becomesProvider: Schema.Boolean,
    lateMs: Schema.Int.check(Schema.isBetween({ maximum: 500, minimum: 100 })),
  },
  ({ becomesProvider, lateMs }) =>
    Effect.gen(function* mixedHolds() {
      yield* TestClock.setTime(0);
      const clock = yield* Clock.Clock;
      const alarms: AlarmLog = { pending: null, sets: 0 };
      const storage = nodeSqlStorage(":memory:");
      const calls = { early: 0, late: 0, share: 0 };
      const notices: string[] = [];

      const parallel = {
        ...plan,
        envelope: { ...plan.envelope, maxAgents: 3, maxDepth: 3 },
        machine: {
          id: "mixed",
          initial: "fan",
          states: {
            done: { type: "final" },
            fan: {
              meta: {
                step: {
                  branches: {
                    early: branch("early"),
                    late: branch("late"),
                    share: branch("share"),
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

      const host = makePlanRun({
        alarms: alarmsFor(alarms),
        guardMs: 30,
        services: Layer.mergeAll(
          Judge.unwired,
          Mail.unwired,
          Layer.succeed(Clock.Clock, clock),
          Layer.succeed(Random.Random, {
            nextDoubleUnsafe: () => 0.5,
            nextIntUnsafe: () => 1,
          }),
          Layer.succeed(ProviderResume, { attempts: 1, baseMs: 10, capMs: 10 }),
          Layer.succeed(
            Operator,
            Operator.of({
              held: (_runId, held) =>
                Effect.sync(() => {
                  if (held.provider !== "caller-share") {
                    notices.push(held.key);
                  }
                }),
              holdAlarm: () => Effect.void,
              notify: () => Effect.void,
            })
          ),
          Layer.succeed(
            Thinker,
            Thinker.of({
              decide: () => Effect.die("unused"),
              elaborate: () => Effect.die("unused"),
              think: ({ key, prompt }) =>
                Effect.gen(function* unavailableThink() {
                  const selected = yield* Schema.decodeUnknownEffect(
                    Schema.Literals(["early", "late", "share"])
                  )(prompt).pipe(
                    Effect.mapError(
                      (failure) =>
                        new StepFailed({ key, reason: failure.message })
                    )
                  );

                  calls[selected] += 1;

                  return yield* new ProviderUnavailable({
                    cause: "busy",
                    key,
                    provider:
                      selected === "share" &&
                      (!becomesProvider || calls.share === 1)
                        ? "caller-share"
                        : "proxy",
                    retryAfter: selected === "late" ? lateMs : 0,
                    status: 429,
                  });
                }),
            })
          )
        ),
        storage,
      });

      yield* callAndDrive(host, "submitPlan", {
        plan: parallel,
        runId: "mixed",
      });
      expect(alarms.pending).toBe(5);
      yield* TestClock.setTime(5);
      yield* Effect.promise(host.alarm);
      expect(alarms.pending).toBe(10);
      yield* TestClock.setTime(lateMs + 10);
      yield* Effect.promise(host.alarm);
      expect(alarms.pending).toBe(becomesProvider ? null : lateMs + 20);
      expect(calls).toEqual({ early: 2, late: 1, share: 2 });
      expect(notices.filter((key) => key.includes("share"))).toHaveLength(
        becomesProvider ? 1 : 0
      );
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 15 } }
);
