import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer, Option, Schema } from "effect";

import { decodePlan } from "../../src/plans/schema.js";
import {
  bufferedRunStore,
  memoryRunBackend,
  RunStore,
} from "../../src/runs/run-store.js";
import type { RunBackend } from "../../src/runs/run-store.js";
import { DocsSchema, RunStateSchema } from "../../src/runs/schema.js";
import type { RunReport } from "../../src/runs/schema.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

export const MigrationWorldSchema = Schema.Struct({
  length: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
  prompt: Schema.Literals(["research", "draft", "review"]),
  width: Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 2 })),
});

export const MigrationCaptureSchema = Schema.Struct({
  docs: DocsSchema,
  fingerprints: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  journal: Schema.Array(Schema.Tuple([Schema.String, Schema.Json])),
  messages: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  paused: Schema.Boolean,
  state: RunStateSchema,
});

export const MigrationFixtureSchema = Schema.Struct({
  body: Schema.Json,
  captures: Schema.Array(MigrationCaptureSchema),
  compiled: Schema.Json,
  expected: Schema.Struct({
    docs: DocsSchema,
    status: Schema.String,
    value: Schema.NullOr(Schema.String),
  }),
  fingerprints: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  plan: Schema.Json,
  submitted: Schema.String,
  world: MigrationWorldSchema,
});

export const MigrationCorpusSchema = Schema.Struct({
  fixtures: Schema.Array(MigrationFixtureSchema),
  source: Schema.Struct({
    bridge: Schema.String,
    commit: Schema.String,
    seed: Schema.Int,
    xstate: Schema.String,
  }),
});

export type MigrationCapture = typeof MigrationCaptureSchema.Type;

export const MIGRATION_RUN = "migration";

export const migrationPlan = (world: typeof MigrationWorldSchema.Type) => ({
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: 7,
    maxDepth: 3,
    maxSteps: 40,
    maxThinking: "low",
    models: ["sol"],
    names: ["shadow/reviewer"],
    thresholds: { judge: 0.8 },
  },
  goal: "Resume a line of thoughts, fan out and collect replies",
  id: "migration",
  machine: {
    id: "migration",
    initial: "s0",
    states: {
      done: { type: "final" },
      fan: {
        meta: {
          step: {
            branches: Object.fromEntries(
              Array.from({ length: world.width }, (_, index) => [
                `b${index}`,
                {
                  initial: "think",
                  states: {
                    ask: {
                      meta: {
                        step: {
                          kind: "ask",
                          message: `review ${index}`,
                          to: "shadow/reviewer",
                          writes: `reply_${index}`,
                        },
                      },
                      on: { replied: { target: "done" } },
                    },
                    done: { type: "final" },
                    think: {
                      meta: {
                        step: {
                          kind: "think",
                          prompt: `${world.prompt} branch ${index}`,
                          writes: `branch_${index}`,
                        },
                      },
                      on: { done: { target: "ask" } },
                    },
                  },
                },
              ])
            ),
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: { done: { target: "signoff" } },
      },
      signoff: {
        meta: { step: { kind: "ask-joel", question: "Finish?" } },
        on: { no: { target: "done" }, yes: { target: "done" } },
      },
      ...Object.fromEntries(
        Array.from({ length: world.length }, (_, index) => [
          `s${index}`,
          {
            meta: {
              step: {
                kind: "think",
                prompt: `${world.prompt} line ${index}`,
                writes: `line_${index}`,
              },
            },
            on: {
              done: {
                target: index + 1 === world.length ? "fan" : `s${index + 1}`,
              },
            },
          },
        ])
      ),
    },
  },
  version: 1,
});

export const migrationServices = Layer.mergeAll(
  NodeCrypto.layer,
  Judge.unwired,
  Layer.succeed(
    Thinker,
    Thinker.of({
      decide: () => Effect.die("migration fixture has no judge"),
      elaborate: () => Effect.die("migration fixture has no sketch"),
      think: ({ prompt }) =>
        Effect.succeed({ output: `thought:${prompt}`, tokens: 1 }),
    })
  ),
  Layer.succeed(
    Mail,
    Mail.of({
      seal: ({ key, message, runId, visit }) =>
        Effect.succeed({
          envelope: message,
          messageId: `${runId}/${key}#${visit}`,
        }),
      send: () => Effect.void,
    })
  ),
  Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
);

export const migrationHost = (backend: RunBackend) =>
  RunHost.make.pipe(
    Effect.provide(migrationServices),
    Effect.provideService(RunStore, bufferedRunStore(backend))
  );

export const finishMigration = Effect.fn("finishMigration")(
  function* finishMigration(
    host: RunHost["Service"],
    initial: RunReport,
    order: readonly number[]
  ) {
    let report = initial;
    let cursor = 0;

    while (report.status !== "done" && cursor < 12) {
      const pending = report.awaiting ?? [];

      const ask =
        pending[
          (order[cursor % Math.max(1, order.length)] ?? 0) %
            Math.max(1, pending.length)
        ];

      if (report.status === "waiting-for-reply" && ask !== undefined) {
        report = yield* host.deliver({
          body: `reply:${ask.key}`,
          from: ask.to,
          replyTo: ask.messageId,
        });
      } else if (report.status === "waiting-for-joel") {
        report = yield* host.answer(MIGRATION_RUN, "yes");
      } else {
        report = yield* host.resume(MIGRATION_RUN);
      }

      cursor += 1;
    }

    return report;
  }
);

export const captureMigration = Effect.fn("captureMigration")(
  function* captureMigration(
    backend: RunBackend,
    messages: ReadonlyMap<string, string>
  ) {
    const state = yield* backend.readRun(MIGRATION_RUN);

    return {
      docs: yield* backend.readDocs(MIGRATION_RUN),
      fingerprints: [...(yield* backend.readFingerprints(MIGRATION_RUN))],
      journal: [...(yield* backend.readJournal(MIGRATION_RUN))],
      messages: [...messages],
      paused: yield* backend.readPaused(MIGRATION_RUN),
      state: Option.getOrThrow(state),
    };
  }
);

export const restoreMigration = Effect.fn("restoreMigration")(
  function* restoreMigration(capture: MigrationCapture, input: Schema.Json) {
    const plan = yield* decodePlan(input);
    const backend = memoryRunBackend();

    yield* backend.apply(MIGRATION_RUN, {
      docs: new Map(Object.entries(capture.docs)),
      fingerprints: new Map(capture.fingerprints),
      journal: new Map(capture.journal),
      messages: new Map(capture.messages),
      paused: capture.paused,
      plans: new Map([[plan.version, plan]]),
      replaceDocs: true,
      run: capture.state,
    });

    return backend;
  }
);
