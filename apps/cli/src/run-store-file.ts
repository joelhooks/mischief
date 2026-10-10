import {
  DocsSchema,
  PlanSchema,
  RunStateSchema,
  RunStore,
} from "@mischief/core";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

const JournalSchema = Schema.Record(Schema.String, Schema.Json);

const PausedSchema = Schema.Boolean;

export const runStoreFile = (root: string) =>
  Layer.effect(
    RunStore,
    Effect.gen(function* makeRunStoreFile() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const fileOf = (runId: string, name: string) =>
        path.join(root, runId, name);

      const readAs = <A>(schema: Schema.Codec<A>, file: string) =>
        Effect.gen(function* readJsonFile() {
          if (!(yield* fs.exists(file))) {
            return Option.none<A>();
          }

          const text = yield* fs.readFileString(file);

          return Option.some(
            yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text)
          );
        }).pipe(Effect.orDie);

      const writeAs = <A>(schema: Schema.Codec<A>, file: string, value: A) =>
        Effect.gen(function* writeJsonFile() {
          const text = yield* Schema.encodeEffect(
            Schema.fromJsonString(schema)
          )(value);

          const staging = `${file}.tmp`;

          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(staging, text);
          yield* fs.rename(staging, file);
        }).pipe(Effect.orDie);

      const journalOf = (runId: string) =>
        readAs(JournalSchema, fileOf(runId, "journal.json")).pipe(
          Effect.map(Option.getOrElse(() => ({})))
        );

      const docsOf = (runId: string) =>
        readAs(DocsSchema, fileOf(runId, "docs.json")).pipe(
          Effect.map(Option.getOrElse(() => ({})))
        );

      return RunStore.of({
        readDocs: docsOf,
        readJournal: (runId) =>
          journalOf(runId).pipe(
            Effect.map((entries) => new Map(Object.entries(entries)))
          ),
        readPaused: (runId) =>
          readAs(PausedSchema, fileOf(runId, "paused.json")).pipe(
            Effect.map(Option.getOrElse(() => false))
          ),
        readPlan: (runId, version) =>
          readAs(PlanSchema, fileOf(runId, `plan.v${version}.json`)),
        readRun: (runId) => readAs(RunStateSchema, fileOf(runId, "run.json")),
        writeDoc: (runId, name, doc) =>
          docsOf(runId).pipe(
            Effect.flatMap((docs) =>
              writeAs(DocsSchema, fileOf(runId, "docs.json"), {
                ...docs,
                [name]: doc,
              })
            )
          ),
        writeJournal: (runId, key, entry) =>
          journalOf(runId).pipe(
            Effect.flatMap((entries) =>
              writeAs(JournalSchema, fileOf(runId, "journal.json"), {
                ...entries,
                [key]: entry,
              })
            )
          ),
        writePaused: (runId, paused) =>
          writeAs(PausedSchema, fileOf(runId, "paused.json"), paused),
        writePlan: (runId, plan) =>
          writeAs(
            PlanSchema,
            fileOf(runId, `plan.v${plan.version}.json`),
            plan
          ),
        writeRun: (runId, state) =>
          writeAs(RunStateSchema, fileOf(runId, "run.json"), state),
      });
    })
  );
