import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import * as TestClock from "effect/testing/TestClock";

import { JudgeModeSchema } from "../../src/runs/schema.js";
import type { Docs, RunReport, RunStatus } from "../../src/runs/schema.js";
import { alarmFor } from "../../src/schedules/decide.js";
import {
  completeSchedule,
  createSchedule,
  inspectSchedule,
  wakeSchedule,
} from "../../src/schedules/host.js";
import type { ScheduleInput } from "../../src/schedules/host.js";
import { ScheduleAlarm } from "../../src/schedules/schedule-alarm.js";
import { ScheduleStore } from "../../src/schedules/schedule-store.js";
import { wakeRunId } from "../../src/schedules/schema.js";
import type { ScheduleState } from "../../src/schedules/schema.js";
import { WakeRuns } from "../../src/schedules/wake-runs.js";

const ID = "climb";

const START = 1_000_000_000_000;

const MINUTE = 60_000;

const CARRY = "notes";

const zeroStep = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 20,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Nothing to do",
  id: "no-op",
  machine: { id: "no-op", initial: "end", states: { end: { type: "final" } } },
};

const RunScriptSchema = Schema.Struct({
  done: Schema.Boolean,
  life: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
  status: Schema.Literals(["done", "failed", "aborted"]),
  stuck: Schema.Boolean,
  writesCarry: Schema.Boolean,
});

type RunScript = typeof RunScriptSchema.Type;

const StepSchema = Schema.Struct({
  crashAt: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 0 }))
  ),
  gapSlots: Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 0 })),
  jitter: Schema.Int.check(Schema.isBetween({ maximum: 59_999, minimum: 0 })),
});

const WorldSchema = Schema.Struct({
  carry: Schema.Boolean,
  escalateTo: Schema.NullOr(Schema.Literal("agent-graph/desk")),
  everyMinutes: Schema.Int.check(Schema.isBetween({ maximum: 30, minimum: 1 })),
  judge: Schema.NullOr(JudgeModeSchema),
  maxWakes: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 1 }))
  ),
  runs: Schema.NonEmptyArray(RunScriptSchema),
  steps: Schema.Array(StepSchema).check(Schema.isMaxLength(24)),
  timeoutSlots: Schema.Int.check(Schema.isBetween({ maximum: 40, minimum: 1 })),
  wakeTimeoutSlots: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 }))
  ),
});

type World = typeof WorldSchema.Type;

interface LiveRun {
  readonly n: number;
  readonly startedStep: number;
  readonly script: RunScript;
  readonly docs: Docs;
  submits: number;
  aborted: boolean;
}

const makeWorld = (world: World) => {
  const runs = new Map<string, LiveRun>();
  const violations: string[] = [];

  let state: Option.Option<ScheduleState> = Option.none();
  let alarm: number | null = null;
  let step = 0;
  let calls = 0;
  let crashAt: number | null = null;

  const port = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      const index = calls;

      calls += 1;

      return index === crashAt
        ? Effect.die("a planted crash before this port call")
        : effect;
    });

  const statusOf = (run: LiveRun): RunStatus => {
    if (run.aborted) {
      return "aborted";
    }

    return !run.script.stuck && step - run.startedStep >= run.script.life
      ? run.script.status
      : "running";
  };

  const reportOf = (run: LiveRun): RunReport => {
    const status = statusOf(run);
    const finished = status !== "running";

    const docs: Record<string, Schema.Json> = {};

    if (finished && run.script.writesCarry) {
      docs[CARRY] = `from ${String(run.n)}`;
    }

    if (finished && run.script.done) {
      docs.done = true;
    }

    return {
      docs,
      planId: "no-op",
      planVersion: 1,
      runId: wakeRunId(ID, run.n),
      status,
      transitions: 0,
      value: null,
    };
  };

  const layer = Layer.mergeAll(
    Layer.succeed(
      ScheduleStore,
      ScheduleStore.of({
        load: port(Effect.sync(() => state)),
        save: (next) =>
          port(
            Effect.sync(() => {
              state = Option.some(next);
            })
          ),
      })
    ),
    Layer.succeed(
      ScheduleAlarm,
      ScheduleAlarm.of({
        set: (at) =>
          port(
            Effect.sync(() => {
              alarm = at;
            })
          ),
      })
    ),
    Layer.succeed(
      WakeRuns,
      WakeRuns.of({
        abort: (runId) =>
          port(
            Effect.sync(() => {
              const run = runs.get(runId);

              if (run !== undefined && statusOf(run) === "running") {
                run.aborted = true;
              }
            })
          ),
        inspect: (runId) =>
          port(
            Effect.sync(() =>
              Option.map(Option.fromNullishOr(runs.get(runId)), reportOf)
            )
          ),
        submit: (runId, _plan, docs, { escalateTo, judge }) =>
          port(
            Effect.sync(() => {
              if (judge !== world.judge) {
                violations.push(
                  `${runId} was submitted with judge ${String(judge)}, not the schedule's ${String(world.judge)}`
                );
              }

              if (escalateTo !== world.escalateTo) {
                violations.push(
                  `${runId} was submitted with escalateTo ${String(escalateTo)}, not the schedule's ${String(world.escalateTo)}`
                );
              }

              const existing = runs.get(runId);

              if (existing !== undefined) {
                existing.submits += 1;

                return;
              }

              const n = runs.size + 1;

              if (runId !== wakeRunId(ID, n)) {
                violations.push(
                  `wake ${runId} was submitted as run ${String(n)}`
                );
              }

              const before = runs.get(wakeRunId(ID, n - 1));

              if (before !== undefined && statusOf(before) === "running") {
                violations.push(
                  `${runId} started while ${wakeRunId(ID, n - 1)} was running`
                );
              }

              const fromBefore =
                before?.aborted === true
                  ? before.docs[CARRY]
                  : `from ${String(before?.n)}`;

              const expected = before === undefined ? "seed" : fromBefore;

              if (world.carry && docs[CARRY] !== expected) {
                violations.push(
                  `${runId} got ${CARRY} ${JSON.stringify(docs[CARRY])}, not ${JSON.stringify(expected)}`
                );
              }

              runs.set(runId, {
                aborted: false,
                docs,
                n,
                script:
                  world.runs[(n - 1) % world.runs.length] ?? world.runs[0],
                startedStep: step,
                submits: 1,
              });
            })
          ),
      })
    )
  );

  const checkAlarm = (when: string) => {
    if (Option.isNone(state)) {
      return;
    }

    const wanted = alarmFor(state.value);

    if (wanted !== null && (alarm === null || alarm > wanted)) {
      violations.push(
        `${when}: alarm ${String(alarm)} is later than the state's ${String(wanted)}`
      );
    }
  };

  const fire = (crash: number | null) =>
    Effect.gen(function* attempt() {
      calls = 0;
      crashAt = crash;

      const exit = yield* Effect.exit(
        wakeSchedule().pipe(Effect.provide(layer))
      );

      crashAt = null;

      if (Exit.isFailure(exit) && crash === null) {
        violations.push(`an uncrashed wake failed: ${String(exit.cause)}`);
      }

      checkAlarm(
        crash === null
          ? `step ${String(step)}`
          : `crash ${String(crash)} at step ${String(step)}`
      );
    });

  return {
    advance: () => {
      step += 1;
    },
    alarm: () => alarm,
    fire,
    layer,
    runs,
    state: () => state,
    violations,
  };
};

const inputFor = (world: World): ScheduleInput => ({
  carry: world.carry ? [CARRY] : [],
  docs: world.carry ? { [CARRY]: "seed" } : {},
  escalateTo: world.escalateTo ?? undefined,
  every: `${String(world.everyMinutes)} minutes`,
  judge: world.judge ?? undefined,
  maxWakes: world.maxWakes ?? undefined,
  plan: zeroStep,
  scheduleId: ID,
  timeout: `${String(world.timeoutSlots * world.everyMinutes)} minutes`,
  wakeTimeout:
    world.wakeTimeoutSlots === null
      ? undefined
      : `${String(world.wakeTimeoutSlots * world.everyMinutes)} minutes`,
});

const play = (world: World) =>
  Effect.gen(function* played() {
    const sim = makeWorld(world);
    const every = world.everyMinutes * MINUTE;

    let now = START;

    yield* TestClock.setTime(now);
    yield* createSchedule(inputFor(world)).pipe(Effect.provide(sim.layer));

    const fireDue = (crash: number | null) =>
      Effect.gen(function* due() {
        let attempts = 0;
        let crashed = crash;

        while (attempts < 6) {
          const at = sim.alarm();

          if (at === null || at > now) {
            return;
          }

          yield* sim.fire(crashed);
          crashed = null;
          attempts += 1;
        }

        sim.violations.push(`the alarm kept firing at ${String(now)}`);
      });

    for (const step of world.steps) {
      sim.advance();
      now += step.gapSlots * every + step.jitter;
      yield* TestClock.setTime(now);
      yield* fireDue(step.crashAt);
    }

    const last = sim.alarm();

    if (last !== null) {
      sim.advance();
      now = Math.max(now, last);
      yield* TestClock.setTime(now);
      yield* fireDue(null);
    }

    return sim;
  });

type Sim = ReturnType<typeof makeWorld>;

const submittedViolations = (state: ScheduleState, sim: Sim) => {
  const problems: string[] = [];

  for (let n = 1; n <= state.wakeCount; n += 1) {
    if (!sim.runs.has(wakeRunId(ID, n))) {
      problems.push(`wake ${String(n)} was recorded but never submitted`);
    }
  }

  if (sim.runs.size !== state.wakeCount) {
    problems.push(
      `${String(sim.runs.size)} runs for ${String(state.wakeCount)} wakes`
    );
  }

  return problems;
};

const collapseViolations = (state: ScheduleState) =>
  state.wakes.flatMap((wake, index) => {
    const before = state.wakes[index - 1];

    return before !== undefined && wake.due <= before.at
      ? [
          `wake ${String(wake.n)} was due ${String(wake.due)}, not after wake ${String(before.n)} at ${String(before.at)}`,
        ]
      : [];
  });

const budgetViolations = (state: ScheduleState, sim: Sim) => {
  const wakeAt = new Map(state.wakes.map(({ at, runId }) => [runId, at]));

  const late = state.skips.flatMap((skip) => {
    const blocking = /\((?<runId>[a-z0-9-]+)\)/u.exec(skip.reason)?.groups
      ?.runId;

    const started = blocking === undefined ? undefined : wakeAt.get(blocking);

    return state.wakeTimeoutMs !== null &&
      started !== undefined &&
      skip.at - started >= state.wakeTimeoutMs
      ? [
          `a slot at ${String(skip.at)} was skipped for ${String(blocking)}, past its wakeTimeout`,
        ]
      : [];
  });

  const aborted = [...sim.runs.values()].filter(({ aborted: was }) => was);

  return aborted.length === state.abortCount
    ? late
    : [
        ...late,
        `${String(aborted.length)} runs were aborted but ${String(state.abortCount)} aborts recorded`,
      ];
};

const endViolations = (world: World, state: ScheduleState, sim: Sim) => {
  const problems: string[] = [];

  if (state.ended === null && sim.alarm() === null) {
    problems.push("a live schedule has no alarm");
  }

  if (state.ended?.reason === "cap" && state.wakeCount !== world.maxWakes) {
    problems.push(
      `ended at the cap after ${String(state.wakeCount)} wakes, cap ${String(world.maxWakes)}`
    );
  }

  if (world.maxWakes !== null && state.wakeCount > world.maxWakes) {
    problems.push(
      `${String(state.wakeCount)} wakes past the cap ${String(world.maxWakes)}`
    );
  }

  return problems;
};

const settledViolations = (world: World, sim: Sim) => {
  const state = Option.getOrThrow(sim.state());

  return [
    ...sim.violations,
    ...submittedViolations(state, sim),
    ...collapseViolations(state),
    ...budgetViolations(state, sim),
    ...endViolations(world, state, sim),
  ];
};

it.effect.prop(
  "wakes survive a crash before any port call: no lost or doubled wake, one at a time, missed slots collapse, carry docs pass on",
  { world: Arbitrary.schema(WorldSchema) },
  ({ world }) =>
    Effect.gen(function* property() {
      const sim = yield* play(world);

      const problems = settledViolations(world, sim);

      expect(problems, problems.join("\n")).toStrictEqual([]);
    }),
  { arbitrary: { runs: 300 }, timeout: 60_000 }
);

const refusalOf = (input: Partial<ScheduleInput>) =>
  Effect.gen(function* refusal() {
    const sim = makeWorld({
      carry: false,
      escalateTo: null,
      everyMinutes: 1,
      judge: null,
      maxWakes: 1,
      runs: [
        {
          done: false,
          life: 0,
          status: "done",
          stuck: false,
          writesCarry: false,
        },
      ],
      steps: [],
      timeoutSlots: 1,
      wakeTimeoutSlots: null,
    });

    const exit = yield* Effect.exit(
      createSchedule({ plan: zeroStep, scheduleId: ID, ...input }).pipe(
        Effect.provide(sim.layer)
      )
    );

    return { exit, stored: sim.state() };
  });

it.effect(
  "createSchedule refuses each bad field with a fix, and stores nothing",
  () =>
    Effect.gen(function* refusals() {
      const cases: readonly (readonly [Partial<ScheduleInput>, string])[] = [
        [{ maxWakes: 3 }, "give exactly one of every"],
        [
          { cron: "0 9 * * *", every: "1 hour", maxWakes: 3 },
          "give exactly one of every",
        ],
        [{ every: "30 seconds", maxWakes: 3 }, "shorter than 1 minute"],
        [{ every: "often", maxWakes: 3 }, 'every "often" is not a duration'],
        [
          { cron: "nine o'clock", maxWakes: 3 },
          `cron "nine o'clock" does not parse`,
        ],
        [{ every: "1 hour" }, "give maxWakes, timeout or both"],
        [
          { every: "1 hour", timeout: "soon" },
          'timeout "soon" is not a finite duration',
        ],
        [
          { carry: ["notes"], every: "1 hour", maxWakes: 3 },
          'carry doc "notes" has no starting value',
        ],
        [
          { every: "1 hour", maxWakes: 3, plan: { goal: "no machine" } },
          "Missing key",
        ],
      ];

      for (const [input, reason] of cases) {
        const { exit, stored } = yield* refusalOf(input);

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(reason);
        expect(Option.isNone(stored)).toBe(true);
      }
    })
);

it.effect(
  "a cron schedule's first wake is the next matching minute in UTC",
  () =>
    Effect.gen(function* cronFirst() {
      const sim = makeWorld({
        carry: false,
        escalateTo: null,
        everyMinutes: 1,
        judge: null,
        maxWakes: 2,
        runs: [
          {
            done: false,
            life: 0,
            status: "done",
            stuck: false,
            writesCarry: false,
          },
        ],
        steps: [],
        timeoutSlots: 1,
        wakeTimeoutSlots: null,
      });

      yield* TestClock.setTime(Date.UTC(2026, 9, 12, 8, 30));

      const report = yield* createSchedule({
        cron: "0 9 * * *",
        maxWakes: 2,
        plan: zeroStep,
        scheduleId: ID,
      }).pipe(Effect.provide(sim.layer));

      expect(report.nextAt).toBe(Date.UTC(2026, 9, 12, 9, 0));
      expect(sim.alarm()).toBe(Date.UTC(2026, 9, 12, 9, 0));
    })
);

it.effect(
  "createSchedule again returns the stored schedule; completeSchedule ends it and clears the alarm",
  () =>
    Effect.gen(function* lifecycle() {
      const sim = makeWorld({
        carry: false,
        escalateTo: null,
        everyMinutes: 5,
        judge: null,
        maxWakes: 3,
        runs: [
          {
            done: false,
            life: 0,
            status: "done",
            stuck: false,
            writesCarry: false,
          },
        ],
        steps: [],
        timeoutSlots: 10,
        wakeTimeoutSlots: null,
      });

      yield* TestClock.setTime(START);

      const first = yield* createSchedule({
        every: "5 minutes",
        maxWakes: 3,
        plan: zeroStep,
        scheduleId: ID,
      }).pipe(Effect.provide(sim.layer));

      const again = yield* createSchedule({
        every: "1 hour",
        maxWakes: 9,
        plan: zeroStep,
        scheduleId: ID,
      }).pipe(Effect.provide(sim.layer));

      expect(again).toStrictEqual(first);

      const done = yield* completeSchedule(ID).pipe(Effect.provide(sim.layer));

      expect(done.ended?.reason).toBe("completed");
      expect(done.nextAt).toBeNull();
      expect(sim.alarm()).toBeNull();

      const inspected = yield* inspectSchedule(ID).pipe(
        Effect.provide(sim.layer)
      );

      expect(inspected).toStrictEqual(done);
    })
);
