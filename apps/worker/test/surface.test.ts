import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { FetchHttpClient } from "effect/http";

import { getJson, post, prepare, start } from "./workerd.js";

const DESKS = ["alpha", "beta"] as const;

const askPlan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 20,
    maxThinking: "low",
    models: ["sol"],
    names: DESKS.map((desk) => `desk/${desk}`),
    thresholds: { judge: 0.8 },
  },
  goal: "Ask two desks in turn",
  id: "asks",
  machine: {
    id: "asks",
    initial: "alpha",
    states: {
      alpha: {
        meta: {
          step: {
            kind: "ask",
            message: "alpha?",
            to: "desk/alpha",
            writes: "alpha",
          },
        },
        on: { replied: { target: "beta" } },
      },
      beta: {
        meta: {
          step: {
            kind: "ask",
            message: "beta?",
            to: "desk/beta",
            writes: "beta",
          },
        },
        on: { replied: { target: "end" } },
      },
      end: { type: "final" },
    },
  },
};

const ReportSchema = Schema.Struct({
  awaiting: Schema.optionalKey(
    Schema.Array(Schema.Struct({ messageId: Schema.String }))
  ),
  docs: Schema.Record(Schema.String, Schema.Json),
  status: Schema.String,
});

const decodeReport = Schema.decodeUnknownSync(ReportSchema);

const SpecSchema = Schema.Struct({
  paths: Schema.Record(Schema.String, Schema.Json),
});

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

it.live.prop(
  "a shadow driver can submit, deliver replies by replyTo alone, and inspect, against runs that share one Worker",
  {
    runIds: Arbitrary.schema(
      Schema.Array(Schema.Literals(["board-1", "board-2", "card-27"])).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(3),
        Schema.isUnique()
      )
    ),
  },
  ({ runIds }) =>
    Effect.gen(function* property() {
      const world = yield* prepare(30_000);

      yield* start(world);

      for (const runId of runIds) {
        const submitted = decodeReport(
          (yield* post(world, "submitPlan", { plan: askPlan, runId })).body
        );

        expect(submitted.status).toBe("waiting-for-reply");
      }

      for (const desk of DESKS) {
        for (const runId of runIds) {
          const waiting = decodeReport(
            (yield* post(world, "inspectRun", { runId })).body
          );

          const replyTo = waiting.awaiting?.[0]?.messageId ?? "";

          expect(replyTo.startsWith(`${runId}/`)).toBe(true);

          const delivered = yield* post(world, "deliverReply", {
            body: `${runId} ${desk} ok`,
            from: `desk/${desk}`,
            replyTo,
          });

          expect(delivered.status).toBe(200);
        }
      }

      for (const runId of runIds) {
        const final = decodeReport(
          (yield* post(world, "inspectRun", { runId })).body
        );

        expect(final.status).toBe("done");
        expect(final.docs).toMatchObject({
          alpha: `${runId} alpha ok`,
          beta: `${runId} beta ok`,
        });
      }

      const spec = yield* Schema.decodeUnknownEffect(SpecSchema)(
        yield* getJson(world, "/openapi.json")
      );

      expect(Object.keys(spec.paths)).toEqual(
        expect.arrayContaining([
          "/submitPlan",
          "/deliverReply",
          "/inspectRun",
          "/reviseRun",
          "/readRun",
        ])
      );
    }).pipe(Effect.scoped, Effect.provide(services)),
  { arbitrary: { runs: 4 }, timeout: 120_000 }
);
