import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Crypto, Effect, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { compilePlan } from "../../src/plans/compile.js";
import { decodePlan } from "../../src/plans/schema.js";
import { fingerprintOf } from "../../src/runs/fingerprint.js";
import { MigrationCorpus } from "./migration-corpus.js";
import {
  MigrationWorldSchema,
  MIGRATION_RUN,
  finishMigration,
  migrationHost,
  migrationPlan,
  restoreMigration,
} from "./migration-support.js";

const outcome = (report: {
  readonly docs: unknown;
  readonly status: string;
  readonly value?: string | null | undefined;
}) => ({
  docs: report.docs,
  status: report.status,
  value: report.value ?? null,
});

it.layer(MigrationCorpus.layer)("XState migration", (test) => {
  test.effect(
    "every alpha.65 commit boundary reopens, accepts the same submission and finishes with the old value and documents",
    () =>
      Effect.gen(function* fixturesReopen() {
        const corpus = yield* MigrationCorpus;

        for (const fixture of corpus.fixtures) {
          for (const capture of fixture.captures) {
            const backend = yield* restoreMigration(capture, fixture.plan);
            const host = yield* migrationHost(backend);

            const resubmitted = yield* host.submit(
              MIGRATION_RUN,
              fixture.body,
              {
                seed: "kept",
              }
            );

            expect(resubmitted.runId).toBe(MIGRATION_RUN);
            const resumed = yield* host.resume(MIGRATION_RUN);
            const finished = yield* finishMigration(host, resumed, [0, 1, 2]);
            expect(outcome(finished)).toStrictEqual(fixture.expected);
          }
        }
      })
  );

  test.effect(
    "compiled machine JSON, submission fingerprints and each executed step fingerprint are unchanged",
    () =>
      Effect.gen(function* fingerprintsUnchanged() {
        const corpus = yield* MigrationCorpus;
        const crypto = yield* Crypto.Crypto;

        for (const fixture of corpus.fixtures) {
          const plan = yield* decodePlan(fixture.plan);

          const compiled = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Json)
          )(JSON.stringify(compilePlan(plan)));

          expect(compiled).toStrictEqual(fixture.compiled);
          expect(
            yield* fingerprintOf(crypto, {
              docs: { seed: "kept" },
              plan: fixture.body,
            })
          ).toBe(fixture.submitted);
          const [capture] = fixture.captures;

          if (capture === undefined) {
            return yield* Effect.die("old engine capture list is empty");
          }

          const backend = yield* restoreMigration(capture, fixture.plan);
          const host = yield* migrationHost(backend);
          yield* finishMigration(host, yield* host.resume(MIGRATION_RUN), [0]);
          expect(
            Object.fromEntries(yield* backend.readFingerprints(MIGRATION_RUN))
          ).toStrictEqual(Object.fromEntries(fixture.fingerprints));
        }

        return true;
      }).pipe(Effect.provide(NodeCrypto.layer))
  );

  const HistorySchema = Schema.Struct({
    capture: Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 0 })),
    order: Schema.Array(
      Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 0 }))
    ).check(Schema.isMaxLength(6)),
    pauses: Schema.Array(Schema.Boolean).check(Schema.isMaxLength(3)),
  });

  test.effect.prop(
    "generated plans persisted by alpha.65 converge through generated restart, pause and reply histories on the new engine",
    {
      history: Arbitrary.schema(HistorySchema),
      world: Arbitrary.schema(MigrationWorldSchema),
    },
    ({ history, world }) =>
      Effect.gen(function* migrationProperty() {
        const corpus = yield* MigrationCorpus;

        const fixture = corpus.fixtures.find(
          (candidate) =>
            candidate.world.length === world.length &&
            candidate.world.width === world.width &&
            candidate.world.prompt === world.prompt
        );

        expect(fixture).toBeDefined();

        if (fixture === undefined) {
          return yield* Effect.die(
            "old engine capture missing for a generated plan"
          );
        }

        expect(migrationPlan(world)).toStrictEqual(fixture.body);

        const capture =
          fixture.captures[history.capture % fixture.captures.length];

        if (capture === undefined) {
          return yield* Effect.die("old engine capture list is empty");
        }

        const backend = yield* restoreMigration(capture, fixture.plan);
        let host = yield* migrationHost(backend);

        for (const paused of history.pauses) {
          if (paused) {
            yield* host.pause(MIGRATION_RUN);
          }

          host = yield* migrationHost(backend);
        }

        const resumed = yield* host.resume(MIGRATION_RUN);
        const finished = yield* finishMigration(host, resumed, history.order);
        const state = Option.getOrThrow(yield* backend.readRun(MIGRATION_RUN));
        expect(outcome(finished)).toStrictEqual(fixture.expected);
        expect(state.submitted).toBe(fixture.submitted);

        return true;
      }),
    { arbitrary: { runs: 100, seed: 700_065 } }
  );
});
