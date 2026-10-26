import type { SqlStorage } from "@mischief/plan-run";
import { Effect, Option, Schema, Semaphore } from "effect";

import { Mailroom } from "./mailroom-port.js";
import type { PostboxFailed } from "./postbox-failed.js";

const Column = Schema.Struct({ name: Schema.String });

const Pending = Schema.Struct({
  envelope: Schema.NullOr(Schema.String),
  message_id: Schema.String,
  reason: Schema.String,
  run_id: Schema.String,
  sender: Schema.String,
});

export const abortReplyText = (
  runId: string,
  messageId: string,
  reason: string
) =>
  `Your reply ${messageId} reached Mischief run ${runId}. The run was aborted before it finished: ${reason}. Nothing your reply fed carried forward. Resend it as a reply to the next wake's ask, or contact the run's owner. SR 🐀`;

export const postboxAborts = (
  storage: SqlStorage,
  send: (envelope: string) => Effect.Effect<void, PostboxFailed, Mailroom>
) => {
  const columns = new Set(
    storage.sql
      .exec("PRAGMA table_info(postbox_delivered)")
      .toArray()
      .flatMap((row) =>
        Option.toArray(Schema.decodeUnknownOption(Column)(row)).map(
          ({ name }) => name
        )
      )
  );

  for (const [name, type] of [
    ["run_id", "TEXT"],
    ["sender", "TEXT"],
    ["envelope", "TEXT"],
    ["notified", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    if (name !== undefined && !columns.has(name)) {
      storage.sql.exec(
        `ALTER TABLE postbox_delivered ADD COLUMN ${name} ${type}`
      );
    }
  }

  storage.sql.exec(
    "CREATE INDEX IF NOT EXISTS postbox_delivered_run ON postbox_delivered (run_id, notified)"
  );
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS postbox_aborted (run_id TEXT PRIMARY KEY, reason TEXT NOT NULL)"
  );

  const sending = Semaphore.makeUnsafe(1);

  const flush = Effect.gen(function* flushAbortNotices() {
    let after = "";

    while (true) {
      const [raw] = storage.sql
        .exec(
          "SELECT d.message_id, d.run_id, d.sender, d.envelope, a.reason FROM postbox_aborted a CROSS JOIN postbox_delivered d ON d.run_id = a.run_id WHERE d.notified = 0 AND d.sender IS NOT NULL AND d.message_id > ? ORDER BY d.message_id LIMIT 1",
          after
        )
        .toArray();

      if (raw === undefined) {
        break;
      }

      const row = yield* Schema.decodeUnknownEffect(Pending)(raw).pipe(
        Effect.orDie
      );

      after = row.message_id;

      let { envelope } = row;

      if (envelope === null) {
        const sealed = yield* Mailroom.use((mailroom) =>
          mailroom.seal(
            row.sender,
            abortReplyText(row.run_id, row.message_id, row.reason)
          )
        );

        ({ envelope } = sealed);
        storage.sql.exec(
          "UPDATE postbox_delivered SET envelope = ? WHERE message_id = ? AND run_id = ?",
          envelope,
          row.message_id,
          row.run_id
        );
      }

      yield* send(envelope);
      storage.sql.exec(
        "UPDATE postbox_delivered SET notified = 1 WHERE message_id = ? AND run_id = ?",
        row.message_id,
        row.run_id
      );
    }
  }).pipe(sending.withPermits(1));

  const markAborted = (runId: string, reason: string) => {
    storage.sql.exec(
      "INSERT INTO postbox_aborted (run_id, reason) VALUES (?, ?) ON CONFLICT (run_id) DO NOTHING",
      runId,
      reason
    );
  };

  const abort = (runId: string, reason: string) =>
    Effect.sync(() => {
      markAborted(runId, reason);
    }).pipe(Effect.andThen(flush));

  return { abort, flush, markAborted };
};
