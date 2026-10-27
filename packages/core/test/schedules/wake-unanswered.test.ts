import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";

import { createSchedule, wakeSchedule } from "../../src/schedules/host.js";
import { ScheduleAlarm } from "../../src/schedules/schedule-alarm.js";
import { ScheduleStore } from "../../src/schedules/schedule-store.js";
import type { ScheduleState } from "../../src/schedules/schema.js";
import { WakeRuns } from "../../src/schedules/wake-runs.js";
import { WakeUnanswered } from "../../src/schedules/wake-unanswered.js";

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

it.effect.prop(
  "a wake whose run object does not answer fails with WakeUnanswered and leaves the schedule running for the alarm's retry",
  {
    failing: Schema.Literals(["inspectRun", "submitPlan"]),
    reason: Schema.Literals(["answered 500", "did not answer: reset"]),
  },
  ({ failing, reason }) =>
    Effect.gen(function* unansweredWake() {
      const stored = { state: Option.none<ScheduleState>() };

      const unanswered = (runId: string, step: WakeUnanswered["step"]) =>
        new WakeUnanswered({ reason, runId, scheduleId: "climb", step });

      const layer = Layer.mergeAll(
        Layer.succeed(
          ScheduleStore,
          ScheduleStore.of({
            load: Effect.sync(() => stored.state),
            save: (next) =>
              Effect.sync(() => {
                stored.state = Option.some(next);
              }),
          })
        ),
        Layer.succeed(
          ScheduleAlarm,
          ScheduleAlarm.of({ set: () => Effect.void })
        ),
        Layer.succeed(
          WakeRuns,
          WakeRuns.of({
            abort: () => Effect.void,
            inspect: (runId) => Effect.fail(unanswered(runId, "inspectRun")),
            submit: (runId) =>
              failing === "submitPlan"
                ? Effect.fail(unanswered(runId, "submitPlan"))
                : Effect.void,
          })
        )
      );

      yield* createSchedule({
        every: "1 minute",
        maxWakes: 3,
        plan: zeroStep,
        scheduleId: "climb",
      }).pipe(Effect.provide(layer));

      if (failing === "inspectRun") {
        yield* wakeSchedule().pipe(Effect.provide(layer));
        yield* TestClock.adjust("1 minute");
      }

      const exit = yield* wakeSchedule().pipe(
        Effect.provide(layer),
        Effect.exit
      );

      expect(Exit.findErrorOption(exit)).toStrictEqual(
        Option.some(unanswered("climb-wake-1", failing))
      );
      expect(stored.state.pipe(Option.map(({ ended }) => ended))).toStrictEqual(
        Option.some(null)
      );
    })
);
