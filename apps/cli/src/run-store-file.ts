import {
  DocsSchema,
  PlanSchema,
  RunStateSchema,
  RunStore,
} from "@mischief/core";
import {
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
} from "effect";

const JournalSchema = Schema.Record(Schema.String, Schema.Json);

const FingerprintsSchema = Schema.Record(Schema.String, Schema.String);

const PausedSchema = Schema.Boolean;

const MessageSchema = Schema.Struct({ runId: Schema.String });

export const runStoreFile = (root: string) =>
  Layer.effect(
    RunStore,
    Effect.gen(function* makeRunStoreFile() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const writes = yield* Semaphore.make(1);
      const locked = writes.withPermits(1);

      const fileOf = (runId: string, name: string) =>
        path.join(root, runId, name);

      const readAs = <A, I>(schema: Schema.Codec<A, I>, file: string) =>
        Effect.gen(function* readJsonFile() {
          if (!(yield* fs.exists(file))) {
            return Option.none<A>();
          }

          const text = yield* fs.readFileString(file);

          return Option.some(
            yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text)
          );
        }).pipe(Effect.orDie);

      const writeAs = <A, I>(
        schema: Schema.Codec<A, I>,
        file: string,
        value: A
      ) =>
        Effect.gen(function* writeJsonFile() {
          const text = yield* Schema.encodeEffect(
            Schema.fromJsonString(schema)
          )(value);

          const staging = `${file}.tmp`;

          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(staging, text);
          yield* fs.rename(staging, file);
        }).pipe(Effect.orDie);

      const messageFile = (messageId: string) =>
        path.join(root, "__messages", `${encodeURIComponent(messageId)}.json`);

      const journalOf = (runId: string) =>
        readAs(JournalSchema, fileOf(runId, "journal.json")).pipe(
          Effect.map(Option.getOrElse(() => ({})))
        );

      const docsOf = (runId: string) =>
        readAs(DocsSchema, fileOf(runId, "docs.json")).pipe(
          Effect.map(Option.getOrElse(() => ({})))
        );

      const fingerprintsOf = (runId: string) =>
        readAs(FingerprintsSchema, fileOf(runId, "fingerprints.json")).pipe(
          Effect.map(Option.getOrElse(() => ({})))
        );

      return RunStore.of({
        readDocs: docsOf,
        readFingerprints: (runId) =>
          fingerprintsOf(runId).pipe(
            Effect.map((entries) => new Map(Object.entries(entries)))
          ),
        readJournal: (runId) =>
          journalOf(runId).pipe(
            Effect.map((entries) => new Map(Object.entries(entries)))
          ),
        readMessage: (messageId) =>
          readAs(MessageSchema, messageFile(messageId)).pipe(
            Effect.map(Option.map(({ runId }) => runId))
          ),
        readPaused: (runId) =>
          readAs(PausedSchema, fileOf(runId, "paused.json")).pipe(
            Effect.map(Option.getOrElse(() => false))
          ),
        readPlan: (runId, version) =>
          readAs(PlanSchema, fileOf(runId, `plan.v${version}.json`)),
        readRun: (runId) => readAs(RunStateSchema, fileOf(runId, "run.json")),
        replaceDocs: (runId, docs) =>
          locked(writeAs(DocsSchema, fileOf(runId, "docs.json"), docs)),
        writeDoc: (runId, name, doc) =>
          locked(
            docsOf(runId).pipe(
              Effect.flatMap((docs) =>
                writeAs(DocsSchema, fileOf(runId, "docs.json"), {
                  ...docs,
                  [name]: doc,
                })
              )
            )
          ),
        writeFingerprint: (runId, key, fingerprint) =>
          locked(
            fingerprintsOf(runId).pipe(
              Effect.flatMap((entries) =>
                writeAs(
                  FingerprintsSchema,
                  fileOf(runId, "fingerprints.json"),
                  { ...entries, [key]: fingerprint }
                )
              )
            )
          ),
        writeJournal: (runId, key, entry) =>
          locked(
            journalOf(runId).pipe(
              Effect.flatMap((entries) =>
                writeAs(JournalSchema, fileOf(runId, "journal.json"), {
                  ...entries,
                  [key]: entry,
                })
              )
            )
          ),
        writeMessage: (messageId, runId) =>
          locked(writeAs(MessageSchema, messageFile(messageId), { runId })),
        writePaused: (runId, paused) =>
          locked(writeAs(PausedSchema, fileOf(runId, "paused.json"), paused)),
        writePlan: (runId, plan) =>
          locked(
            writeAs(
              PlanSchema,
              fileOf(runId, `plan.v${plan.version}.json`),
              plan
            )
          ),
        writeRun: (runId, state) =>
          locked(writeAs(RunStateSchema, fileOf(runId, "run.json"), state)),
      });
    })
  );
