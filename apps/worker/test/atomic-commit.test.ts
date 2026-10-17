import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { post, prepare, start } from "./workerd.js";

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

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
  goal: "Think once",
  id: "atomic-plan",
  machine: {
    id: "atomic-plan",
    initial: "think",
    states: {
      done: { type: "final" },
      think: {
        meta: { step: { kind: "think", prompt: "once", writes: "thought" } },
        on: { done: { target: "done" } },
      },
    },
  },
};

const Report = Schema.Struct({
  docs: Schema.Record(Schema.String, Schema.Json),
  status: Schema.String,
});

it.live(
  "a commit too big for SQLite writes nothing, so the run it would have started does not exist and a resubmit starts clean",
  () =>
    Effect.gen(function* tooBig() {
      const world = yield* prepare(30_000);

      yield* start(world);

      const refused = yield* post(world, "submitPlan", {
        docs: Object.fromEntries([
          ["small", "seeded"],
          ["big", "x".repeat(12 * 1024 * 1024)],
        ]),
        plan,
        runId: "atomic",
      });

      expect(refused.status).toBeGreaterThanOrEqual(500);

      const missing = yield* post(world, "inspectRun", { runId: "atomic" });

      expect(missing.status).toBeGreaterThanOrEqual(400);
      expect(missing.status).toBeLessThan(500);

      const resubmitted = yield* post(world, "submitPlan", {
        plan,
        runId: "atomic",
      }).pipe(
        Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(Report)(body))
      );

      expect(resubmitted.status).toBe("done");
      expect(Object.keys(resubmitted.docs).toSorted()).toEqual(["thought"]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  90_000
);
