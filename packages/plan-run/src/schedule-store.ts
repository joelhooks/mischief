import { ScheduleStateSchema, ScheduleStore } from "@mischief/core";
import { Effect, Option, Schema } from "effect";

import type { SqlStorage } from "./sql.js";

const SCHEMA =
  "CREATE TABLE IF NOT EXISTS mischief_schedule (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)";

const StateText = Schema.fromJsonString(ScheduleStateSchema);

const StateRow = Schema.Struct({ state: Schema.String });

export const scheduleStoreSql = (
  storage: SqlStorage
): ScheduleStore["Service"] => {
  const rows = (query: string, ...bindings: string[]) => {
    storage.sql.exec(SCHEMA);

    return storage.sql.exec(query, ...bindings).toArray();
  };

  return ScheduleStore.of({
    load: Effect.suspend(() =>
      Option.match(
        Schema.decodeUnknownOption(StateRow)(
          rows("SELECT state FROM mischief_schedule WHERE id = 1")[0]
        ),
        {
          onNone: () => Effect.succeedNone,
          onSome: ({ state }) =>
            Schema.decodeUnknownEffect(StateText)(state).pipe(
              Effect.map(Option.some),
              Effect.orDie
            ),
        }
      )
    ),
    save: (state) =>
      Schema.encodeEffect(StateText)(state).pipe(
        Effect.orDie,
        Effect.flatMap((text) =>
          Effect.sync(() => {
            rows(
              "INSERT INTO mischief_schedule (id, state) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state",
              text
            );
          })
        )
      ),
  });
};
