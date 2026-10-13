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

const gate = {
  ...zeroStep,
  goal: "One judged gate",
  id: "gate",
  machine: {
    id: "gate",
    initial: "gate",
    states: {
      end: { type: "final" },
      gate: {
        meta: { step: { kind: "judge", question: "Go or stop?" } },
        on: { go: { target: "end" }, stop: { target: "end" } },
      },
    },
  },
};

const Wake = Schema.Struct({
  failures: Schema.optionalKey(
    Schema.Array(Schema.Struct({ reason: Schema.String }))
  ),
  status: Schema.String,
});

it.live(
  "a schedule's judge reaches every wake: jev on a host without a key fails the wake's gate, the host default parks it on shadow/judge",
  () =>
    Effect.gen(function* judged() {
      const world = yield* prepare(30_000);

      yield* start(world);

      const settle = (runId: string) =>
        post(world, "inspectRun", { runId }).pipe(
          Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(Wake)(body)),
          Effect.filterOrFail(
            ({ status }) => status !== "running",
            () => `${runId} is still running`
          ),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 })
        );

      for (const [scheduleId, judge] of [
        ["asks-jev", "jev"],
        ["asks-host", null],
      ] as const) {
        const input = {
          every: "1 minute",
          maxWakes: 1,
          plan: gate,
          scheduleId,
        };

        const created = yield* post(
          world,
          "createSchedule",
          judge === null ? input : { ...input, judge }
        );

        expect(created.body).toMatchObject({ judge });
      }

      const jev = yield* settle("asks-jev-wake-1");

      expect(jev.status).toBe("failed");
      expect(JSON.stringify(jev.failures)).toContain('judge \\"jev\\"');

      const host = yield* settle("asks-host-wake-1");

      expect(host.status).toBe("waiting-for-reply");
    }).pipe(Effect.scoped, Effect.provide(services)),
  60_000
);
