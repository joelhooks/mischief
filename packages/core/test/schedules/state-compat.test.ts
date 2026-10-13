import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { Every, ScheduleStateSchema } from "../../src/schedules/schema.js";

it.effect(
  "a schedule stored before wakeTimeout and escalateTo decodes with no wake limit, no aborts and no escalation desk",
  () =>
    Effect.gen(function* storedBefore() {
      const state = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ScheduleStateSchema)
      )(
        JSON.stringify({
          cadence: Every.make({ ms: 60_000 }),
          carry: [],
          createdAt: 1_791_838_338_723,
          docs: { brief: "proof" },
          ended: null,
          endsAt: null,
          maxWakes: 2,
          nextAt: 1_791_838_398_723,
          pendingDocs: { brief: "proof" },
          plan: { goal: "Nothing to do" },
          scheduleId: "celld-proof-1",
          skipCount: 0,
          skips: [],
          wakeCount: 1,
          wakes: [
            {
              at: 1_791_838_338_728,
              due: 1_791_838_338_723,
              n: 1,
              runId: "celld-proof-1-wake-1",
            },
          ],
        })
      );

      expect(state.wakeTimeoutMs).toBeNull();
      expect(state.escalateTo).toBeNull();
      expect(state.aborting).toBeNull();
      expect(state.judge).toBeNull();
      expect(state.abortCount).toBe(0);
      expect(state.aborts).toStrictEqual([]);
    })
);
