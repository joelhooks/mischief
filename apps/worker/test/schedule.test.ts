import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { freshCaller, post, prepare, start } from "./workerd.js";

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

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

const Report = Schema.Struct({
  ended: Schema.NullOr(Schema.Struct({ reason: Schema.String })),
  nextAt: Schema.NullOr(Schema.Number),
  wakeCount: Schema.Number,
  wakes: Schema.Array(Schema.Struct({ runId: Schema.String })),
});

const RunDone = Schema.Struct({
  docs: Schema.Record(Schema.String, Schema.Json),
  status: Schema.Literal("done"),
});

it.live(
  "a schedule wakes its first run at once under its caller's DID, is invisible to another caller, refuses a bad cadence, and ends on completeSchedule",
  () =>
    Effect.gen(function* lifecycle() {
      const alice = yield* freshCaller("alice");
      const bob = yield* freshCaller("bob");
      const world = yield* prepare(30_000, [alice, bob]);

      yield* start(world);

      const created = yield* post(
        world,
        "createSchedule",
        {
          docs: { brief: "climb the hill" },
          every: "1 minute",
          maxWakes: 2,
          plan: zeroStep,
          scheduleId: "climb",
        },
        alice
      );

      expect(created.status).toBe(200);
      expect(
        (yield* Schema.decodeUnknownEffect(Report)(created.body)).wakeCount
      ).toBe(0);

      const firstWake = yield* post(
        world,
        "inspectRun",
        { runId: "climb-wake-1" },
        alice
      ).pipe(
        Effect.filterOrFail(
          ({ body }) => Schema.is(RunDone)(body),
          () => "wake 1 has not finished yet"
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
        Effect.catch(() =>
          post(world, "inspectRun", { runId: "climb-wake-1" }, alice)
        )
      );

      expect(firstWake.body).toMatchObject({
        docs: { brief: "climb the hill" },
        status: "done",
      });

      const inspected = yield* Schema.decodeUnknownEffect(Report)(
        (yield* post(world, "inspectSchedule", { scheduleId: "climb" }, alice))
          .body
      );

      expect(inspected.wakeCount).toBe(1);
      expect(inspected.wakes.map(({ runId }) => runId)).toStrictEqual([
        "climb-wake-1",
      ]);

      const foreign = yield* post(
        world,
        "inspectSchedule",
        { scheduleId: "climb" },
        bob
      );

      expect(foreign.status).not.toBe(200);
      expect(JSON.stringify(foreign.body)).toContain("UnknownSchedule");

      const foreignRun = yield* post(
        world,
        "inspectRun",
        { runId: "climb-wake-1" },
        bob
      );

      expect(foreignRun.status).not.toBe(200);

      const nameless = yield* post(world, "inspectSchedule", {}, alice);

      expect(nameless.status).toBe(400);
      expect(JSON.stringify(nameless.body)).toContain("names no schedule");

      const fast = yield* post(
        world,
        "createSchedule",
        {
          every: "30 seconds",
          maxWakes: 2,
          plan: zeroStep,
          scheduleId: "fast",
        },
        alice
      );

      expect(fast.status).toBe(422);
      expect(JSON.stringify(fast.body)).toContain("shorter than 1 minute");

      const completed = yield* Schema.decodeUnknownEffect(Report)(
        (yield* post(world, "completeSchedule", { scheduleId: "climb" }, alice))
          .body
      );

      expect(completed.ended?.reason).toBe("completed");
      expect(completed.nextAt).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(services)),
  60_000
);
