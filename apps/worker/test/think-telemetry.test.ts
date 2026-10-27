import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ThinkStatusSchema } from "@mischief/core";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { post, prepare, start } from "./workerd.js";

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

const thinkPlan = {
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: 2,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Think twice",
  id: "telemetry-plan",
  machine: {
    id: "telemetry-plan",
    initial: "first",
    states: {
      done: { type: "final" },
      first: {
        meta: { step: { kind: "think", prompt: "first", writes: "one" } },
        on: { done: { target: "second" } },
      },
      second: {
        meta: { step: { kind: "think", prompt: "second", writes: "two" } },
        on: { done: { target: "done" } },
      },
    },
  },
};

const Report = Schema.Struct({
  status: Schema.String,
  thinking: Schema.Struct({
    calls: Schema.Finite,
    line: Schema.String,
    models: Schema.Array(Schema.String),
  }),
});

it.live(
  "every think call that ran is on its run's report and in the host's day total, and status names the default in force",
  () =>
    Effect.gen(function* telemetry() {
      const world = yield* prepare(30_000);

      yield* start(world);

      const runs = yield* Effect.forEach(["t1", "t2"], (runId) =>
        post(world, "submitPlan", { plan: thinkPlan, runId }).pipe(
          Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(Report)(body))
        )
      );

      for (const report of runs) {
        expect(report.status).toBe("done");
        expect(report.thinking.calls).toBe(2);
        expect(report.thinking.line).toMatch(/^think: .* · 2 calls · /u);
      }

      const status = yield* post(world, "thinkStatus", {}).pipe(
        Effect.flatMap(({ body }) =>
          Schema.decodeUnknownEffect(ThinkStatusSchema)(body)
        )
      );

      expect(status.default).toStrictEqual({
        model: "gpt-6.1-sol",
        review: "2026-11-15",
        source: "THINK_DEFAULT in @mischief/thinking; design ledger 2026-10-16",
        thinking: "medium",
      });
      expect(status.host).toStrictEqual({ model: "faux", wired: true });
      expect(status.today.calls).toBe(4);
      expect(status.today.warnAt).toStrictEqual({
        call: 150_000,
        day: status.today.warning.line,
        stepRepeats: 3,
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  60_000
);
