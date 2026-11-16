import type { SqlStorage } from "@mischief/plan-run";
import { Effect, Option, Schema } from "effect";

const MARKS =
  "CREATE TABLE IF NOT EXISTS postbox_reader_marks (id INTEGER PRIMARY KEY CHECK (id = 1), last_read_at INTEGER NOT NULL, empty_turns INTEGER NOT NULL, noticed INTEGER NOT NULL)";

const Row = Schema.Struct({
  empty_turns: Schema.Finite,
  last_read_at: Schema.Finite,
  noticed: Schema.Finite,
  retry_attempts: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
});

export interface ReaderMarks {
  readonly emptyTurns: number;
  readonly lastReadAt: number;
  readonly noticed: boolean;
  readonly retryAttempts?: number;
}

export interface MarksPort {
  readonly get: Effect.Effect<Option.Option<ReaderMarks>>;
  readonly set: (marks: ReaderMarks) => Effect.Effect<void>;
}

export const readerMarks = (storage: SqlStorage): MarksPort => {
  storage.sql.exec(MARKS);

  const columns = storage.sql
    .exec("PRAGMA table_info(postbox_reader_marks)")
    .toArray();

  if (!columns.some(({ name }) => name === "retry_attempts")) {
    storage.sql.exec(
      "ALTER TABLE postbox_reader_marks ADD COLUMN retry_attempts INTEGER NOT NULL DEFAULT 0"
    );
  }

  return {
    get: Effect.sync(() =>
      Option.fromNullishOr(
        storage.sql
          .exec(
            "SELECT last_read_at, empty_turns, noticed, retry_attempts FROM postbox_reader_marks WHERE id = 1"
          )
          .toArray()[0]
      ).pipe(
        Option.flatMap((row) => Schema.decodeUnknownOption(Row)(row)),
        Option.map((row): ReaderMarks => {
          const marks = {
            emptyTurns: row.empty_turns,
            lastReadAt: row.last_read_at,
            noticed: row.noticed !== 0,
          };

          const retryAttempts = row.retry_attempts ?? 0;

          return retryAttempts > 0 ? { ...marks, retryAttempts } : marks;
        })
      )
    ),
    set: ({ emptyTurns, lastReadAt, noticed, retryAttempts }) =>
      Effect.sync(() => {
        storage.sql.exec(
          "INSERT INTO postbox_reader_marks (id, last_read_at, empty_turns, noticed, retry_attempts) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_read_at = excluded.last_read_at, empty_turns = excluded.empty_turns, noticed = excluded.noticed, retry_attempts = excluded.retry_attempts",
          lastReadAt,
          emptyTurns,
          noticed ? 1 : 0,
          retryAttempts ?? 0
        );
      }),
  };
};
