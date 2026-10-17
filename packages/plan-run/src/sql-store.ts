import { bufferedRunStore, PlanSchema, RunStateSchema } from "@mischief/core";
import type { RunBackend, RunChanges, RunStore } from "@mischief/core";
import { Effect, Option, Schema } from "effect";

import type { SqlRow, SqlStorage, SqlValue } from "./sql.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mischief_runs (run_id TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mischief_plans (run_id TEXT NOT NULL, version INTEGER NOT NULL, plan TEXT NOT NULL, PRIMARY KEY (run_id, version));
CREATE TABLE IF NOT EXISTS mischief_docs (run_id TEXT NOT NULL, name TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (run_id, name));
CREATE TABLE IF NOT EXISTS mischief_journal (run_id TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (run_id, key));
CREATE TABLE IF NOT EXISTS mischief_fingerprints (run_id TEXT NOT NULL, key TEXT NOT NULL, print TEXT NOT NULL, PRIMARY KEY (run_id, key));
CREATE TABLE IF NOT EXISTS mischief_paused (run_id TEXT PRIMARY KEY, paused INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mischief_messages (message_id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
`;

const JsonText = Schema.fromJsonString(Schema.Json);

const StateText = Schema.fromJsonString(RunStateSchema);

const PlanText = Schema.fromJsonString(PlanSchema);

const PrintText = Schema.fromJsonString(Schema.String);

const textOf = (value: SqlValue | undefined) =>
  Schema.is(Schema.String)(value) ? value : "";

const read = <A, I>(codec: Schema.Codec<A, I>, text: string) =>
  Schema.decodeUnknownEffect(codec)(text).pipe(Effect.orDie);

const entriesOf = <A>(
  found: readonly SqlRow[],
  name: string,
  value: string,
  codec: Schema.Codec<A, string>
) =>
  Effect.all(
    found.map((row) =>
      read(codec, textOf(row[value])).pipe(
        Effect.map((decoded) => [textOf(row[name]), decoded] as const)
      )
    )
  );

const write = <A, I>(codec: Schema.Codec<A, I>, value: A) =>
  Schema.encodeEffect(codec)(value).pipe(Effect.orDie);

type Statement = readonly [string, ...SqlValue[]];

const docStatements = (runId: string, changes: RunChanges) =>
  Effect.forEach([...changes.docs], ([name, doc]) =>
    write(JsonText, doc).pipe(
      Effect.map((text): Statement => [
        "INSERT INTO mischief_docs (run_id, name, doc) VALUES (?, ?, ?) ON CONFLICT (run_id, name) DO UPDATE SET doc = excluded.doc",
        runId,
        name,
        text,
      ])
    )
  ).pipe(
    Effect.map((upserts): readonly Statement[] =>
      changes.replaceDocs
        ? [["DELETE FROM mischief_docs WHERE run_id = ?", runId], ...upserts]
        : upserts
    )
  );

const journalStatements = (runId: string, changes: RunChanges) =>
  Effect.forEach([...changes.journal], ([key, entry]) =>
    write(JsonText, entry).pipe(
      Effect.map((text): Statement => [
        "INSERT INTO mischief_journal (run_id, key, seq, entry) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM mischief_journal WHERE run_id = ?), ?) ON CONFLICT (run_id, key) DO UPDATE SET entry = excluded.entry, seq = excluded.seq",
        runId,
        key,
        runId,
        text,
      ])
    )
  );

const fingerprintStatements = (runId: string, changes: RunChanges) =>
  Effect.forEach([...changes.fingerprints], ([key, fingerprint]) =>
    write(PrintText, fingerprint).pipe(
      Effect.map((text): Statement => [
        "INSERT INTO mischief_fingerprints (run_id, key, print) VALUES (?, ?, ?) ON CONFLICT (run_id, key) DO UPDATE SET print = excluded.print",
        runId,
        key,
        text,
      ])
    )
  );

const planStatements = (runId: string, changes: RunChanges) =>
  Effect.forEach([...changes.plans.values()], (plan) =>
    write(PlanText, plan).pipe(
      Effect.map((text): Statement => [
        "INSERT INTO mischief_plans (run_id, version, plan) VALUES (?, ?, ?) ON CONFLICT (run_id, version) DO UPDATE SET plan = excluded.plan",
        runId,
        plan.version,
        text,
      ])
    )
  );

const runStatements = (runId: string, changes: RunChanges) =>
  changes.run === undefined
    ? Effect.succeed<readonly Statement[]>([])
    : write(StateText, changes.run).pipe(
        Effect.map((text): readonly Statement[] => [
          [
            "INSERT INTO mischief_runs (run_id, state) VALUES (?, ?) ON CONFLICT (run_id) DO UPDATE SET state = excluded.state",
            runId,
            text,
          ],
        ])
      );

const plainStatements = (
  runId: string,
  changes: RunChanges
): readonly Statement[] => [
  ...[...changes.messages].map(([messageId, owner]): Statement => [
    "INSERT INTO mischief_messages (message_id, run_id) VALUES (?, ?) ON CONFLICT (message_id) DO UPDATE SET run_id = excluded.run_id",
    messageId,
    owner,
  ]),
  ...(changes.paused === undefined
    ? []
    : [
        [
          "INSERT INTO mischief_paused (run_id, paused) VALUES (?, ?) ON CONFLICT (run_id) DO UPDATE SET paused = excluded.paused",
          runId,
          changes.paused ? 1 : 0,
        ] as const,
      ]),
];

const encodedFor = (runId: string, changes: RunChanges) =>
  Effect.all([
    planStatements(runId, changes),
    docStatements(runId, changes),
    fingerprintStatements(runId, changes),
    journalStatements(runId, changes),
    runStatements(runId, changes),
  ]).pipe(
    Effect.map((groups) => [
      ...groups.flat(),
      ...plainStatements(runId, changes),
    ])
  );

export const runBackendSql = (storage: SqlStorage): Effect.Effect<RunBackend> =>
  Effect.gen(function* openSqlStore() {
    const rows = (query: string, ...bindings: SqlValue[]) =>
      storage.sql.exec(query, ...bindings).toArray();

    const column = (query: string, name: string, ...bindings: SqlValue[]) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(rows(query, ...bindings)[0]).pipe(
          Option.map((row) => textOf(row[name]))
        )
      );

    yield* Effect.sync(() => storage.sql.exec(SCHEMA));

    const docsOf = (runId: string) =>
      Effect.sync(() =>
        rows("SELECT name, doc FROM mischief_docs WHERE run_id = ?", runId)
      ).pipe(
        Effect.flatMap((found) => entriesOf(found, "name", "doc", JsonText)),
        Effect.map((entries) => Object.fromEntries(entries))
      );

    return {
      apply: (runId, changes) =>
        encodedFor(runId, changes).pipe(
          Effect.flatMap((statements) =>
            Effect.sync(() => {
              storage.transactionSync(() => {
                for (const [query, ...bindings] of statements) {
                  rows(query, ...bindings);
                }
              });
            })
          )
        ),
      readDocs: docsOf,
      readFingerprints: (runId) =>
        Effect.sync(() =>
          rows(
            "SELECT key, print FROM mischief_fingerprints WHERE run_id = ?",
            runId
          )
        ).pipe(
          Effect.flatMap((found) =>
            entriesOf(found, "key", "print", PrintText)
          ),
          Effect.map((entries) => new Map(entries))
        ),
      readJournal: (runId) =>
        Effect.sync(() =>
          rows(
            "SELECT key, entry FROM mischief_journal WHERE run_id = ? ORDER BY seq",
            runId
          )
        ).pipe(
          Effect.flatMap((found) => entriesOf(found, "key", "entry", JsonText)),
          Effect.map((entries) => new Map(entries))
        ),
      readMessage: (messageId) =>
        column(
          "SELECT run_id FROM mischief_messages WHERE message_id = ?",
          "run_id",
          messageId
        ),
      readPaused: (runId) =>
        Effect.sync(
          () =>
            rows(
              "SELECT paused FROM mischief_paused WHERE run_id = ? AND paused = 1",
              runId
            ).length > 0
        ),
      readPlan: (runId, version) =>
        column(
          "SELECT plan FROM mischief_plans WHERE run_id = ? AND version = ?",
          "plan",
          runId,
          version
        ).pipe(
          Effect.flatMap((text) =>
            Option.isSome(text)
              ? read(PlanText, text.value).pipe(Effect.asSome)
              : Effect.succeedNone
          )
        ),
      readRun: (runId) =>
        column(
          "SELECT state FROM mischief_runs WHERE run_id = ?",
          "state",
          runId
        ).pipe(
          Effect.flatMap((text) =>
            Option.isSome(text)
              ? read(StateText, text.value).pipe(Effect.asSome)
              : Effect.succeedNone
          )
        ),
    };
  });

export const runStoreSql = (
  storage: SqlStorage
): Effect.Effect<RunStore["Service"]> =>
  runBackendSql(storage).pipe(Effect.map(bufferedRunStore));
