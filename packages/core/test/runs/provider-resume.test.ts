import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, Effect, Layer, Option, Random, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import { RunHost } from "../../src/runs/host.js";
import { ProviderResume } from "../../src/runs/provider-resume.js";
import {
  RunStore,
  bufferedRunStore,
  memoryRunBackend,
} from "../../src/runs/run-store.js";
import type { RunState } from "../../src/runs/schema.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { ProviderUnavailable } from "../../src/steps/provider-unavailable.js";
import { Thinker } from "../../src/steps/thinker.js";

const plan = {
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: 1,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Resume an overloaded model proxy",
  id: "draft",
  machine: {
    id: "draft",
    initial: "draft",
    states: {
      done: { type: "final" },
      draft: {
        meta: { step: { kind: "think", prompt: "draft it", writes: "draft" } },
        on: { done: { target: "done" } },
      },
    },
  },
};

const PolicySchema = Schema.Struct({
  attempts: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })),
  baseMs: Schema.Int.check(Schema.isBetween({ maximum: 300, minimum: 50 })),
  capMs: Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 300 })),
});

const ProviderSchema = Schema.Struct({
  billing: Schema.Boolean,
  hintMs: Schema.Int.check(Schema.isBetween({ maximum: 400, minimum: 0 })),
  recovery: Schema.Int.check(Schema.isBetween({ maximum: 800, minimum: 0 })),
  statuses: Schema.Array(
    Schema.NullOr(
      Schema.Literals([408, 429, 500, 502, 503, 507, 520, 599, 402, 403])
    )
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
});

interface Attempt {
  readonly at: number;
  readonly runId: string;
}

const stored = (runId: string) =>
  RunStore.use((store) => store.readRun(runId)).pipe(
    Effect.map(Option.getOrThrow)
  );

const checkSchedule = (
  state: RunState,
  predicted: { readonly attempts: number; readonly held: boolean },
  provider: typeof ProviderSchema.Type,
  policy: typeof PolicySchema.Type
) => {
  expect(state.resumeAttempts).toBe(predicted.attempts);
  expect(state.status).toBe(predicted.held ? "waiting-for-provider" : "done");

  for (const held of state.held) {
    const eligible =
      !provider.billing &&
      held.status !== null &&
      (held.status === 408 ||
        held.status === 429 ||
        (held.status >= 500 && held.status < 600));

    if (!eligible || state.resumeAttempts === policy.attempts) {
      expect(held.resumeAfter).toBeNull();
    } else {
      expect(held.resumeAfter).not.toBeNull();
      expect(held.resumeAfter).toBeGreaterThanOrEqual(held.retryAfter ?? 0);
      expect(held.resumeAfter).toBeGreaterThanOrEqual(held.since);
      expect(held.resumeAfter).toBeLessThan(
        (held.retryAfter ?? held.since) +
          Math.min(policy.capMs, policy.baseMs * 2 ** state.resumeAttempts)
      );
    }
  }
};

const atIndex = <A>(values: readonly A[], index: number) =>
  Option.getOrThrow(Option.fromNullishOr(values[index]));

it.effect.prop(
  "generated provider outages resume only due overloads, survive host replacement, obey hints and the run budget, and journal one cap alarm across redeliveries",
  {
    policy: Arbitrary.schema(PolicySchema),
    providers: Arbitrary.schema(
      Schema.Array(ProviderSchema).check(
        Schema.isMinLength(2),
        Schema.isMaxLength(5)
      )
    ),
    seed: Schema.String,
  },
  ({ policy, providers, seed }) =>
    Effect.gen(function* outageSchedules() {
      const attempts: Attempt[] = [];
      const alarms: string[] = [];
      const manual = { recovered: false };
      const counts = providers.map(() => 0);
      const model = providers.map(() => ({ attempts: 0, held: true }));
      const ids = providers.map((_, index) => `run-${index}`);

      const hostNow = RunHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Judge.unwired,
            Mail.unwired,
            Layer.succeed(ProviderResume, policy),
            Layer.succeed(
              Operator,
              Operator.of({
                holdAlarm: (runId) =>
                  Effect.sync(() => {
                    alarms.push(runId);
                  }),
                notify: () => Effect.void,
              })
            ),
            Layer.succeed(
              Thinker,
              Thinker.of({
                decide: () => Effect.die("unused"),
                elaborate: () => Effect.die("unused"),
                think: ({ key, runId }) =>
                  Effect.gen(function* proxyCall() {
                    const index = ids.indexOf(runId);
                    const provider = providers[index];

                    if (provider === undefined) {
                      return yield* Effect.die("missing provider schedule");
                    }

                    const at = yield* Clock.currentTimeMillis;
                    const count = counts[index] ?? 0;

                    const status =
                      provider.statuses[count % provider.statuses.length] ??
                      null;

                    attempts.push({ at, runId });
                    counts[index] = count + 1;

                    if (
                      manual.recovered ||
                      (count > 0 && at >= provider.recovery)
                    ) {
                      return { output: "drafted", tokens: 1 };
                    }

                    return yield* new ProviderUnavailable({
                      cause: provider.billing ? "billing" : "busy",
                      error: `model proxy overload ${status}`,
                      key,
                      provider: `proxy/${index}`,
                      retryAfter: at + provider.hintMs,
                      status,
                    });
                  }),
              })
            )
          )
        )
      );

      yield* TestClock.setTime(0);

      for (const id of ids) {
        yield* (yield* hostNow).submit(id, plan);
      }

      for (
        let round = 0;
        round < policy.attempts * ids.length + 1;
        round += 1
      ) {
        const states = yield* Effect.all(ids.map(stored));

        const next = states.flatMap((state) =>
          state.held.flatMap(({ resumeAfter }) =>
            resumeAfter === null ? [] : [resumeAfter]
          )
        );

        for (const [index, state] of states.entries()) {
          checkSchedule(
            state,
            atIndex(model, index),
            atIndex(providers, index),
            policy
          );
        }

        if (next.length === 0) {
          break;
        }

        const at = Math.min(...next);
        const now = yield* Clock.currentTimeMillis;

        if (at > now) {
          yield* TestClock.setTime(at - 1);

          const before = attempts.length;
          const sent = alarms.length;

          for (const id of ids) {
            yield* (yield* hostNow).advance(id);
          }

          expect(attempts).toHaveLength(before);
          expect(alarms).toHaveLength(sent);
          expect(yield* Effect.all(ids.map(stored))).toStrictEqual(states);
        }

        yield* TestClock.setTime(at);

        for (const [index, id] of ids.entries()) {
          const state = atIndex(states, index);
          const provider = atIndex(providers, index);
          const predicted = atIndex(model, index);

          const due = state.held.some(
            ({ resumeAfter }) => resumeAfter !== null && resumeAfter <= at
          );

          if (due) {
            predicted.attempts += 1;
            predicted.held = at < provider.recovery;
          }

          yield* (yield* hostNow).advance(id);
        }
      }

      const final = yield* Effect.all(ids.map(stored));

      for (const [index, state] of final.entries()) {
        const id = ids[index] ?? "";

        const expectedAlarm =
          state.resumeAttempts === policy.attempts &&
          state.status === "waiting-for-provider" &&
          state.held.some(
            ({ cause, status }) =>
              cause !== "billing" &&
              status !== null &&
              (status === 408 ||
                status === 429 ||
                (status >= 500 && status < 600))
          );

        expect(alarms.filter((runId) => runId === id)).toHaveLength(
          expectedAlarm ? 1 : 0
        );
      }

      const before = attempts.length;
      const sent = [...alarms];

      yield* TestClock.setTime(100_000);

      for (let delivery = 0; delivery < 3; delivery += 1) {
        for (const id of ids) {
          yield* (yield* hostNow).advance(id);
        }
      }

      expect(attempts).toHaveLength(before);
      expect(alarms).toStrictEqual(sent);
      expect(yield* Effect.all(ids.map(stored))).toStrictEqual(final);

      manual.recovered = true;

      for (const [index, id] of ids.entries()) {
        expect((yield* (yield* hostNow).resume(id)).status).toBe("done");
        expect((yield* stored(id)).resumeAttempts).toBe(
          final[index]?.resumeAttempts
        );
      }
    }).pipe(
      Effect.provide(Layer.fresh(RunStore.memory)),
      Random.withSeed(seed)
    ),
  { arbitrary: { runs: 60 }, timeout: 120_000 }
);

it.effect.prop(
  "sixteen runs recovering together spread their actual model attempts: at most two in any 1000 ms window with stratified independent jitter samples",
  { offset: Schema.Int.check(Schema.isBetween({ maximum: 90, minimum: 10 })) },
  ({ offset }) =>
    Effect.gen(function* staggeredRecovery() {
      const attempts: number[] = [];

      yield* TestClock.setTime(0);

      const hosts = yield* Effect.forEach(
        Array.from({ length: 16 }, (_, index) => index),
        (index) =>
          RunHost.make.pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeCrypto.layer,
                Judge.unwired,
                Mail.unwired,
                Layer.succeed(
                  Operator,
                  Operator.of({ notify: () => Effect.void })
                ),
                Layer.succeed(
                  Thinker,
                  Thinker.of({
                    decide: () => Effect.die("unused"),
                    elaborate: () => Effect.die("unused"),
                    think: ({ key }) =>
                      Effect.gen(function* proxyCall() {
                        const now = yield* Clock.currentTimeMillis;

                        if (now >= 1000) {
                          attempts.push(now);

                          return { output: "drafted", tokens: 1 };
                        }

                        return yield* new ProviderUnavailable({
                          cause: "busy",
                          key,
                          provider: "proxy/shared",
                          retryAfter: 1000,
                          status: 503,
                        });
                      }),
                  })
                )
              )
            ),
            Effect.provideService(Random.Random, {
              nextDoubleUnsafe: () => (index + offset / 100) / 16,
              nextIntUnsafe: () => index,
            })
          )
      );

      for (const [index, host] of hosts.entries()) {
        yield* host.submit(`spread-${index}`, plan);
      }

      const states = yield* Effect.all(
        hosts.map((_, index) => stored(`spread-${index}`))
      );

      const ordered = states
        .map((state, index) => ({
          at: state.held[0]?.resumeAfter ?? -1,
          index,
        }))
        .toSorted((a, b) => a.at - b.at);

      for (const { at, index } of ordered) {
        yield* TestClock.setTime(at);
        const host = atIndex(hosts, index);

        expect((yield* host.advance(`spread-${index}`)).status).toBe("done");
      }

      expect(attempts).toHaveLength(16);

      for (const at of attempts) {
        expect(
          attempts.filter((time) => time >= at && time < at + 1000).length
        ).toBeLessThanOrEqual(2);
      }
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 20 }, timeout: 120_000 }
);

it.effect.prop(
  "a crash after the atomic retry admission spends the attempt once and restores through the ordinary think path",
  {
    crash: Schema.Boolean,
    failures: Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 })),
  },
  ({ crash, failures }) =>
    Effect.gen(function* admittedCrash() {
      const backend = memoryRunBackend();
      const world = { calls: 0, crash: false };

      const makeStore = () =>
        bufferedRunStore({
          ...backend,
          apply: (runId, changes) =>
            backend.apply(runId, changes).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  if (
                    world.crash &&
                    changes.run?.status === "running" &&
                    changes.run.resumeAttempts > 0
                  ) {
                    world.crash = false;

                    return Effect.die("crash after retry admission");
                  }

                  return Effect.void;
                })
              )
            ),
        });

      const hostNow = () =>
        RunHost.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeCrypto.layer,
              Judge.unwired,
              Mail.unwired,
              Layer.succeed(RunStore, makeStore()),
              Layer.succeed(
                Operator,
                Operator.of({ notify: () => Effect.void })
              ),
              Layer.succeed(
                Thinker,
                Thinker.of({
                  decide: () => Effect.die("unused"),
                  elaborate: () => Effect.die("unused"),
                  think: ({ key }) =>
                    Effect.suspend(() => {
                      world.calls += 1;

                      return world.calls > failures
                        ? Effect.succeed({ output: "drafted", tokens: 1 })
                        : Effect.fail(
                            new ProviderUnavailable({
                              cause: "busy",
                              key,
                              provider: "proxy/sol",
                              status: 503,
                            })
                          );
                    }),
                })
              )
            )
          )
        );

      const read = () =>
        backend.readRun("crash").pipe(Effect.map(Option.getOrThrow));

      yield* TestClock.setTime(0);
      yield* (yield* hostNow()).submit("crash", plan);

      for (let attempt = 1; attempt <= failures; attempt += 1) {
        const held = yield* read();

        const at = Option.getOrThrow(
          Option.fromNullishOr(held.held[0]?.resumeAfter)
        );

        yield* TestClock.setTime(at);
        world.crash = crash;

        const outcome = yield* Effect.exit((yield* hostNow()).advance("crash"));

        expect(outcome._tag).toBe(crash ? "Failure" : "Success");

        if (crash) {
          const admitted = yield* read();

          expect(admitted.resumeAttempts).toBe(attempt);
          expect(admitted.status).toBe("running");
          expect(admitted.held).toStrictEqual([]);
          yield* (yield* hostNow()).advance("crash");
        }

        expect((yield* read()).resumeAttempts).toBe(attempt);
        expect(world.calls).toBe(attempt + 1);
      }

      expect((yield* read()).status).toBe("done");
    }),
  { arbitrary: { runs: 30 } }
);
