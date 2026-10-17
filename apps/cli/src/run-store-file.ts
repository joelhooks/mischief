import {
  bufferedRunStore,
  DocsSchema,
  PlanSchema,
  RunStateSchema,
  RunStore,
} from "@mischief/core";
import type { RunBackend } from "@mischief/core";
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

      const backend: RunBackend = {
        apply: (runId, changes) =>
          locked(
            Effect.gen(function* applyChanges() {
              const docs = changes.replaceDocs ? {} : yield* docsOf(runId);
              const prints = yield* fingerprintsOf(runId);
              const journal = yield* journalOf(runId);

              yield* writeAs(DocsSchema, fileOf(runId, "docs.json"), {
                ...docs,
                ...Object.fromEntries(changes.docs),
              });
              yield* writeAs(
                FingerprintsSchema,
                fileOf(runId, "fingerprints.json"),
                { ...prints, ...Object.fromEntries(changes.fingerprints) }
              );
              yield* writeAs(JournalSchema, fileOf(runId, "journal.json"), {
                ...journal,
                ...Object.fromEntries(changes.journal),
              });
              yield* Effect.forEach(
                changes.messages,
                ([messageId, owner]) =>
                  writeAs(MessageSchema, messageFile(messageId), {
                    runId: owner,
                  }),
                { discard: true }
              );
              yield* Effect.forEach(
                changes.plans.values(),
                (plan) =>
                  writeAs(
                    PlanSchema,
                    fileOf(runId, `plan.v${plan.version}.json`),
                    plan
                  ),
                { discard: true }
              );

              if (changes.paused !== undefined) {
                yield* writeAs(
                  PausedSchema,
                  fileOf(runId, "paused.json"),
                  changes.paused
                );
              }

              if (changes.run !== undefined) {
                yield* writeAs(
                  RunStateSchema,
                  fileOf(runId, "run.json"),
                  changes.run
                );
              }
            })
          ),
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
      };

      return bufferedRunStore(backend);
    })
  );
