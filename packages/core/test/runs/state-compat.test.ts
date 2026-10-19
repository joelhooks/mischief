import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { decodePlan } from "../../src/plans/schema.js";
import {
  bufferedRunStore,
  memoryRunBackend,
  RunStore,
} from "../../src/runs/run-store.js";
import { DocsSchema, RunStateSchema } from "../../src/runs/schema.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";
import { inlineOutputsRun } from "./inline-outputs.js";
import { oldHeldRun } from "./old-held.js";

const RunStateJson = Schema.fromJsonString(RunStateSchema);

const OlderStateArbitrary = Arbitrary.map(
  Arbitrary.schema(RunStateSchema),
  (state) => ({
    ...state,
    awaiting: [],
    capped: null,
    checkpoint: null,
    held: [],
    replies: [],
    resumeAttempts: 0,
    submitted: null,
  })
);

it.effect.prop(
  "a run file written before awaiting, capped, held, replies, resumeAttempts and submitted existed still reads",
  { state: OlderStateArbitrary },
  ({ state }) =>
    Effect.gen(function* property() {
      const written = yield* Schema.decodeEffect(RunStateJson)(
        yield* Schema.encodeEffect(RunStateJson)(state)
      );

      const {
        awaiting: _awaiting,
        capped: _capped,
        held: _held,
        replies: _replies,
        resumeAttempts: _resumeAttempts,
        submitted: _submitted,
        ...older
      } = yield* Schema.encodeEffect(RunStateSchema)(written);

      const read = yield* Schema.decodeEffect(RunStateJson)(
        JSON.stringify(older)
      );

      expect(read).toEqual(written);
    }),
  { arbitrary: { runs: 100 } }
);

it.effect(
  "a pre-resume held run keeps its hold and starts with no spent attempts or invented provider hint",
  () =>
    Effect.gen(function* olderHold() {
      const state = yield* Schema.decodeEffect(RunStateJson)(oldHeldRun);

      expect(state.resumeAttempts).toBe(0);
      expect(state.held).toStrictEqual([
        {
          cause: "busy",
          error: "",
          key: "draft",
          provider: "proxy/sol",
          resumeAfter: null,
          retryAfter: null,
          since: 1_700_000_000_000,
          status: 429,
        },
      ]);
    })
);

const InlineOutputsSchema = Schema.fromJsonString(
  Schema.Struct({
    docs: DocsSchema,
    fingerprints: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    journal: Schema.Array(Schema.Tuple([Schema.String, Schema.Json])),
    plan: Schema.Json,
    state: RunStateSchema,
  })
);

it.effect(
  "a run saved mid fan-out with its completions' outputs inline in the checkpoint resumes and finishes without calling the model again",
  () =>
    Effect.gen(function* resumeInline() {
      const stored =
        yield* Schema.decodeEffect(InlineOutputsSchema)(inlineOutputsRun);

      const plan = yield* decodePlan(stored.plan);
      const backend = memoryRunBackend();

      yield* backend.apply("wide", {
        docs: new Map(Object.entries(stored.docs)),
        fingerprints: new Map(stored.fingerprints),
        journal: new Map(stored.journal),
        messages: new Map(),
        paused: undefined,
        plans: new Map([[plan.version, plan]]),
        replaceDocs: false,
        run: stored.state,
      });

      const host = yield* RunHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Judge.unwired,
            Mail.unwired,
            Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
          )
        ),
        Effect.provideService(RunStore, bufferedRunStore(backend)),
        Effect.provideService(
          Thinker,
          Thinker.of({
            decide: () => Effect.die("a resumed run asked the think rung"),
            elaborate: () => Effect.die("a resumed run elaborated"),
            think: () => Effect.die("a resumed run called the model"),
          })
        )
      );

      const report = yield* host.advance("wide");

      expect({
        docs: report.docs,
        status: report.status,
        value: report.value,
      }).toStrictEqual({
        docs: {
          out_0: "answer to p0",
          out_1: "answer to p1",
          out_2: "answer to p2",
        },
        status: "done",
        value: "done",
      });
    })
);

it.effect(
  "an ask parked before awaiting carried its message still reads, with no message",
  () =>
    Effect.gen(function* olderAsk() {
      const state = yield* Schema.decodeEffect(RunStateJson)(
        JSON.stringify({
          ...JSON.parse(oldHeldRun),
          awaiting: [
            { key: "land", messageId: "m-1", to: "desk/a", writes: "a" },
          ],
          held: [],
          status: "waiting-for-reply",
        })
      );

      expect(state.awaiting).toStrictEqual([
        {
          key: "land",
          message: null,
          messageId: "m-1",
          to: "desk/a",
          writes: "a",
        },
      ]);
    })
);
