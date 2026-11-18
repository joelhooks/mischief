import { DeskInspection, DeskName } from "@mischief/core/desk-wake";
import type { SqlStorage } from "@mischief/plan-run";
import { Clock, Effect, Schema, Semaphore } from "effect";

import type { DeskWake } from "./desk-wake-mail.js";
import {
  asleep,
  DeskHost,
  deskAlarmAt,
  deskTurn,
  LEASE_INTERVAL,
} from "./desk-waker-machine.js";
import type { DeskState } from "./desk-waker-machine.js";

const Stored = Schema.Struct({ desk: DeskInspection, name: DeskName });

const Row = Schema.Struct({ value: Schema.fromJsonString(Stored) });

const Notice = Schema.Struct({ key: Schema.String, text: Schema.String });

interface Alarms {
  readonly set: (at: number) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

interface Ports {
  readonly alarms: Alarms;
  readonly host: DeskHost["Service"];
  readonly notify: (
    key: string,
    name: string,
    text: string
  ) => Effect.Effect<void>;
  readonly storage: SqlStorage;
}

const DAY = 24 * 60 * 60 * 1000;

const CHURN_LIMIT = 6;

const logSequence = ({ messageId, name, seq }: DeskWake) =>
  seq === undefined
    ? Effect.void
    : Effect.logInfo("DeskWaker recorded trigger sequence").pipe(
        Effect.annotateLogs({ messageId, name, seq })
      );

export const deskWaker = ({ alarms, host, notify, storage }: Ports) => {
  const { sql } = storage;
  const lock = Semaphore.makeUnsafe(1);

  sql.exec(
    "CREATE TABLE IF NOT EXISTS desk_waker_state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS desk_waker_messages (message_id TEXT PRIMARY KEY, seq INTEGER, recorded_at TEXT NOT NULL, started_at INTEGER)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS desk_waker_starts ON desk_waker_messages (started_at) WHERE started_at IS NOT NULL"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS desk_waker_notices (key TEXT PRIMARY KEY, text TEXT NOT NULL)"
  );

  const read = () => {
    const [row] = sql
      .exec("SELECT value FROM desk_waker_state WHERE id = 1")
      .toArray();

    return row === undefined ? null : Schema.decodeUnknownSync(Row)(row).value;
  };

  const save = (name: string, desk: DeskState) => {
    sql.exec(
      "INSERT INTO desk_waker_state VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value",
      Schema.encodeSync(Row.fields.value)({ desk, name })
    );
  };

  const notice = (key: string, text: string) => {
    sql.exec("INSERT INTO desk_waker_notices VALUES (?, ?)", key, text);
  };

  const checkChurn = (name: string, messageId: string, now: number) => {
    const recent = sql
      .exec(
        "SELECT started_at FROM desk_waker_messages WHERE started_at > ? ORDER BY started_at DESC LIMIT ?",
        now - DAY,
        CHURN_LIMIT + 2
      )
      .toArray();

    if (recent.length === CHURN_LIMIT + 1) {
      notice(
        `churn:${messageId}`,
        `Desk wake churn: ${name} started more than ${CHURN_LIMIT} wakes in 24 hours. Wakes continue; inspectDeskWake and check why the reader keeps exiting.`
      );
    }
  };

  const turn = (
    name: string,
    state: DeskState,
    now: number,
    messageId?: string
  ) =>
    deskTurn({ messageId, name, now, state }).pipe(
      Effect.provideService(DeskHost, host)
    );

  const seen = (messageId: string) =>
    sql
      .exec("SELECT 1 FROM desk_waker_messages WHERE message_id = ?", messageId)
      .toArray().length !== 0;

  const remember = (
    { messageId, seq, recordedAt }: DeskWake,
    startedAt: number | null
  ) => {
    sql.exec(
      "INSERT INTO desk_waker_messages VALUES (?, ?, ?, ?)",
      messageId,
      seq ?? null,
      recordedAt,
      startedAt
    );
  };

  const admit = Effect.fn("DeskWaker.admit")(
    function* takeWake(record: DeskWake) {
      const { messageId, name } = record;

      if (seen(messageId)) {
        return;
      }

      const prior = read()?.desk ?? asleep;
      const now = yield* Clock.currentTimeMillis;
      const next = yield* turn(name, prior, now, messageId);
      const started = next.state === "waking" && next.messageId === messageId;

      const scheduled = started || next.pending?.messageId === messageId;

      if (scheduled) {
        yield* alarms.set(now);
      }

      const added = storage.transactionSync(() => {
        if (seen(messageId)) {
          return false;
        }

        remember(record, started ? now : null);

        if (scheduled) {
          save(name, next);
        }

        if (started) {
          checkChurn(name, messageId, now);
        }

        return true;
      });

      if (added) {
        yield* logSequence(record);
      }
    },
    (effect) => lock.withPermit(effect)
  );

  const wake = (record: DeskWake) =>
    Effect.suspend(() => {
      const state = read()?.desk.state;

      if (state !== "waking" && state !== "backoff") {
        return admit(record);
      }

      if (seen(record.messageId)) {
        return Effect.void;
      }

      remember(record, null);

      return logSequence(record);
    });

  const alarm = Effect.gen(function* wakeAlarm() {
    const record = read();

    if (record === null) {
      return;
    }

    const { desk, name } = record;
    const now = yield* Clock.currentTimeMillis;

    yield* alarms.set(now + LEASE_INTERVAL);

    const next = yield* turn(name, desk, now);

    storage.transactionSync(() => {
      save(name, next);

      if (
        desk.state === "reading" &&
        next.state === "waking" &&
        next.messageId !== null
      ) {
        sql.exec(
          "UPDATE desk_waker_messages SET started_at = ? WHERE message_id = ?",
          now,
          next.messageId
        );
        checkChurn(name, next.messageId, now);
      }

      if (next.state === "wake-failed" && desk.state !== next.state) {
        notice(
          `failed:${next.messageId}`,
          `Desk wake failed: ${name} stopped after ${next.attempts} attempt(s). Last result: ${next.reason}. Check the desk host and inspectDeskWake; a new triggering message can start a fresh wake.`
        );
      }
    });

    const pending = yield* Schema.decodeUnknownEffect(Schema.Array(Notice))(
      sql
        .exec("SELECT key, text FROM desk_waker_notices ORDER BY rowid LIMIT 2")
        .toArray()
    ).pipe(Effect.orDie);

    for (const { key, text } of pending) {
      yield* Effect.logWarning(text);
      yield* notify(key, name, text);
      sql.exec("DELETE FROM desk_waker_notices WHERE key = ?", key);
    }

    const remaining =
      sql.exec("SELECT 1 FROM desk_waker_notices LIMIT 1").toArray().length !==
      0;

    const alarmAt = deskAlarmAt(next);

    if (remaining) {
      yield* alarms.set(now);
    } else if (alarmAt === null) {
      yield* alarms.clear;
    } else {
      yield* alarms.set(alarmAt);
    }
  }).pipe((effect) => lock.withPermit(effect));

  return { alarm, inspect: Effect.sync(() => read()?.desk ?? asleep), wake };
};
