import { NodeServices } from "@effect/platform-node";
import { Crypto, Effect, FileSystem, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { compilePlan } from "../../../../src/plans/compile.js";
import { decodePlan } from "../../../../src/plans/schema.js";
import { fingerprintOf } from "../../../../src/runs/fingerprint.js";
import { memoryRunBackend } from "../../../../src/runs/run-store.js";
import {
  MigrationCorpusSchema,
  MigrationWorldSchema,
  MIGRATION_RUN,
  captureMigration,
  finishMigration,
  migrationHost,
  migrationPlan,
} from "../../migration-support.js";

export const captureAlpha65 = Effect.gen(function* captureOld() {
  const fs = yield* FileSystem.FileSystem;
  const manifest = yield* fs.readFileString("package.json");
  yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        dependencies: Schema.Struct({
          "@xstate/effect": Schema.Literal("0.1.0-alpha.7"),
          xstate: Schema.Literal("6.0.0-alpha.65"),
        }),
      })
    )
  )(manifest);

  const generated = yield* Arbitrary.sampleEffect(
    Arbitrary.schema(MigrationWorldSchema),
    { count: 100, seed: 650_070 }
  );

  const exhaustive = [1, 2, 3].flatMap((length) =>
    [2, 3, 4].flatMap((width) =>
      ["research", "draft", "review"].map((prompt) =>
        Schema.decodeUnknownSync(MigrationWorldSchema)({
          length,
          prompt,
          width,
        })
      )
    )
  );

  const worlds = [
    ...new Map(
      [...generated, ...exhaustive].map((world) => [
        JSON.stringify(world),
        world,
      ])
    ).values(),
  ];

  const fixtures: (typeof MigrationCorpusSchema.Type)["fixtures"][number][] =
    [];

  for (const [index, world] of worlds.entries()) {
    const raw = migrationPlan(world);
    yield* decodePlan(raw);
    const base = memoryRunBackend();

    const captures: (typeof MigrationCorpusSchema.Type)["fixtures"][number]["captures"][number][] =
      [];

    const messages = new Map<string, string>();

    const backend = {
      ...base,
      apply: (runId: string, changes: Parameters<typeof base.apply>[1]) =>
        base.apply(runId, changes).pipe(
          Effect.andThen(
            Effect.gen(function* captureCommit() {
              for (const [key, value] of changes.messages) {
                messages.set(key, value);
              }

              if (Option.isSome(yield* base.readRun(runId))) {
                captures.push(yield* captureMigration(base, messages));
              }
            })
          )
        ),
    };

    const host = yield* migrationHost(backend);
    const report = yield* host.submit(MIGRATION_RUN, raw, { seed: "kept" });
    const finished = yield* finishMigration(host, report, [index % 3, 2, 0, 1]);

    if (finished.status !== "done") {
      return yield* Effect.die("old-engine fixture did not finish");
    }

    const crypto = yield* Crypto.Crypto;
    const plan = Option.getOrThrow(yield* base.readPlan(MIGRATION_RUN, 1));
    fixtures.push({
      body: raw,
      captures,
      compiled: yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Json)
      )(JSON.stringify(compilePlan(plan))),
      expected: {
        docs: finished.docs,
        status: finished.status,
        value: finished.value ?? null,
      },
      fingerprints: [...(yield* base.readFingerprints(MIGRATION_RUN))],
      plan: yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Json)
      )(JSON.stringify(plan)),
      submitted: yield* fingerprintOf(crypto, {
        docs: { seed: "kept" },
        plan: raw,
      }),
      world,
    });
  }

  const data = yield* Schema.encodeEffect(
    Schema.fromJsonString(MigrationCorpusSchema)
  )({
    fixtures,
    source: {
      bridge: "0.1.0-alpha.7",
      commit: "7a986e399b807a6b99e66875cbddd767c29b5f5e",
      seed: 650_070,
      xstate: "6.0.0-alpha.65",
    },
  });

  yield* fs.makeDirectory("test/runs/fixtures/alpha65", { recursive: true });
  yield* fs.writeFileString(
    "test/runs/fixtures/alpha65/runs.json",
    `${JSON.stringify(JSON.parse(data), null, 2)}\n`
  );

  return fixtures.length;
}).pipe(Effect.provide(NodeServices.layer));
