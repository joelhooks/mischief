import type { SqlStorage } from "@mischief/plan-run";
import { Effect, Option, Schema } from "effect";

const MARKS =
  "CREATE TABLE IF NOT EXISTS postbox_reader_marks (id INTEGER PRIMARY KEY CHECK (id = 1), last_read_at INTEGER NOT NULL, empty_turns INTEGER NOT NULL, noticed INTEGER NOT NULL)";

const Row = Schema.Struct({
  empty_turns: Schema.Finite,
  last_read_at: Schema.Finite,
  noticed: Schema.Finite,
});

export interface ReaderMarks {
  readonly emptyTurns: number;
  readonly lastReadAt: number;
  readonly noticed: boolean;
}

export interface MarksPort {
  readonly get: Effect.Effect<Option.Option<ReaderMarks>>;
  readonly set: (marks: ReaderMarks) => Effect.Effect<void>;
}

export const readerMarks = (storage: SqlStorage): MarksPort => {
  storage.sql.exec(MARKS);

  return {
    get: Effect.sync(() =>
      Option.fromNullishOr(
        storage.sql
          .exec(
            "SELECT last_read_at, empty_turns, noticed FROM postbox_reader_marks WHERE id = 1"
          )
          .toArray()[0]
      ).pipe(
        Option.flatMap((row) => Schema.decodeUnknownOption(Row)(row)),
        Option.map((row) => ({
          emptyTurns: row.empty_turns,
          lastReadAt: row.last_read_at,
          noticed: row.noticed !== 0,
        }))
      )
    ),
    set: ({ emptyTurns, lastReadAt, noticed }) =>
      Effect.sync(() => {
        storage.sql.exec(
          "INSERT INTO postbox_reader_marks (id, last_read_at, empty_turns, noticed) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_read_at = excluded.last_read_at, empty_turns = excluded.empty_turns, noticed = excluded.noticed",
          lastReadAt,
          emptyTurns,
          noticed ? 1 : 0
        );
      }),
  };
};
