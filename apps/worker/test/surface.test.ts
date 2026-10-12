import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { FetchHttpClient } from "effect/http";

import { bearer, getJson, post, prepare, start } from "./workerd.js";

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
        (yield* getJson(
          world,
          "/openapi.json",
          yield* bearer(world.driver, "openApi")
        )).body
      );

      const anonymous = yield* getJson(world, "/openapi.json");

      const identity = yield* getJson(world, "/.well-known/rat-king/version");

      expect(anonymous.status).toBe(401);
      expect(identity).toEqual({
        body: { commit: "local", version: "local" },
        status: 200,
      });

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

const gate = {
  initial: "gate_1",
  states: {
    gate_1: {
      meta: { step: { kind: "judge", question: "Go or stop?" } },
      on: { go: { target: "passed" }, stop: { target: "passed" } },
    },
    passed: { type: "final" },
  },
};

const gatesPlan = {
  ...askPlan,
  envelope: { ...askPlan.envelope, names: [] },
  goal: "Two shadow-judged gates in parallel",
  id: "gates",
  machine: {
    id: "gates",
    initial: "check",
    states: {
      check: {
        meta: {
          step: {
            branches: { left_side: gate, right_side: gate },
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: { done: { target: "end" } },
      },
      end: { type: "final" },
    },
  },
};

it.live(
  "on the shadow host, parallel judges park the run until shadow/judge answers each one by replyTo",
  () =>
    Effect.gen(function* gates() {
      const world = yield* prepare(30_000);

      yield* start(world);

      const parked = decodeReport(
        (yield* post(world, "submitPlan", {
          plan: gatesPlan,
          runId: "shadow-gates",
        })).body
      );

      const ids = (parked.awaiting ?? []).map(({ messageId }) => messageId);

      expect(parked.status).toBe("waiting-for-reply");
      expect(ids.toSorted()).toStrictEqual([
        "shadow-gates/check.left_side.gate_1#1",
        "shadow-gates/check.right_side.gate_1#1",
      ]);

      const verdict = (replyTo: string) =>
        post(world, "deliverReply", {
          body: '{"choice":"go"}',
          from: "shadow/judge",
          replyTo,
        }).pipe(Effect.map(({ body }) => decodeReport(body)));

      const half = yield* verdict("shadow-gates/check.left_side.gate_1#1");

      expect(half.status).toBe("waiting-for-reply");
      expect(half.awaiting?.map(({ messageId }) => messageId)).toStrictEqual([
        "shadow-gates/check.right_side.gate_1#1",
      ]);

      const done = yield* verdict("shadow-gates/check.right_side.gate_1#1");

      expect(done.status).toBe("done");
    }).pipe(Effect.scoped, Effect.provide(services)),
  120_000
);
