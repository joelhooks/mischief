import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Schedule, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { FetchHttpClient } from "effect/http";

import { kill, post, prepare, start } from "./workerd.js";
import type { Workerd } from "./workerd.js";

const GUARD_MS = 500;

const namesOf = (length: number) =>
  Array.from({ length }, (_, index) => `step${index}`);

const thinkThen = (name: string, target: string) => ({
  meta: { step: { kind: "think", prompt: name, writes: name } },
  on: { done: { target } },
});

const chainOf = (length: number) => {
  const names = namesOf(length);

  return {
    defaults: { agent: {} },
    envelope: {
      maxAgents: length,
      maxDepth: 3,
      maxSteps: 100,
      maxThinking: "low",
      models: ["sol"],
      names: [],
      thresholds: { judge: 0.8 },
    },
    goal: "Think in a line, survive a SIGKILL",
    id: "line",
    machine: {
      id: "line",
      initial: "step0",
      states: {
        ...Object.fromEntries(
          names.map((name, index) => [
            name,
            thinkThen(name, names[index + 1] ?? "end"),
          ])
        ),
        end: { type: "final" },
      },
    },
  };
};

const ReportSchema = Schema.Struct({
  docs: Schema.Record(Schema.String, Schema.Json),
  status: Schema.String,
  transitions: Schema.Number,
});

const decodeReport = Schema.decodeUnknownOption(ReportSchema);

const seen = { recovered: 0, unsent: 0, whole: 0 };

const settled = (world: Workerd) =>
  post(world, "inspectRun", { runId: "line" }).pipe(
    Effect.map(({ body }) => decodeReport(body)),
    Effect.filterOrFail(
      (report) => Option.exists(report, ({ status }) => status !== "running"),
      () => "still running"
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 80 }),
    Effect.map(Option.getOrNull)
  );

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

it.live.prop(
  "a run whose workerd is SIGKILLed at any point is finished by its alarm after restart and ends where the plan model ends",
  {
    killAfterMs: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 120, minimum: 0 }))
    ),
    length: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: 6 }))
    ),
  },
  ({ killAfterMs, length }) =>
    Effect.gen(function* property() {
      const world = yield* prepare(GUARD_MS);
      const plan = chainOf(length);
      const first = yield* start(world);

      const submitted = yield* post(world, "submitPlan", {
        plan,
        runId: "line",
      }).pipe(Effect.option, Effect.forkScoped);

      yield* Effect.sleep(killAfterMs);
      yield* kill(first);
      yield* start(world);

      const early = yield* post(world, "inspectRun", { runId: "line" });
      const report = decodeReport(early.body);

      if (early.status !== 200) {
        seen.unsent += 1;
        yield* post(world, "submitPlan", { plan, runId: "line" });
      } else if (Option.exists(report, ({ status }) => status === "running")) {
        seen.recovered += 1;
      } else {
        seen.whole += 1;
      }

      const final = yield* settled(world);

      expect(final?.status).toBe("done");
      expect(final?.transitions).toBe(length + 1);

      for (const name of namesOf(length)) {
        expect(final?.docs[name]).toBe(`faux answer to: ${name}`);
      }

      yield* Fiber.await(submitted);
    }).pipe(Effect.scoped, Effect.provide(services)),
  { arbitrary: { runs: 25 }, timeout: 180_000 }
);

it("some killed run was still running at restart, so the alarm path was exercised", () => {
  expect(seen.recovered).toBeGreaterThan(0);
});

it.live.prop(
  "the Worker serves only a request bearing its token",
  {
    token: Arbitrary.schema(
      Schema.Literals(["", "test-toke", "test-token2", "other"])
    ),
  },
  ({ token }) =>
    Effect.gen(function* property() {
      const world = yield* prepare(GUARD_MS);

      yield* start(world);

      const refused = yield* post(
        world,
        "inspectRun",
        { runId: "line" },
        token
      );

      const allowed = yield* post(world, "inspectRun", { runId: "line" });

      expect(refused.status).toBe(401);
      expect(allowed.status).not.toBe(401);
    }).pipe(Effect.scoped, Effect.provide(services)),
  { arbitrary: { runs: 4 }, timeout: 60_000 }
);
