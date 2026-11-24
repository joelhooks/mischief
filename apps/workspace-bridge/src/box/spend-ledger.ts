import { DatabaseSync } from "node:sqlite";

import type { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";

import { refusal } from "../protocol.js";
import { BoxImageKey } from "./spend-protocol.js";
import type {
  BoxOwner,
  SpendAdmissionResult,
  SpendLimitsConfig,
  SpendReading,
} from "./spend-protocol.js";

const MINUTE = 60_000;

const DAY = 86_400_000;

const CounterRow = Schema.Struct({ tokens: Schema.Int });

const StoredRequest = Schema.Struct({
  day: Schema.Int,
  imageKey: BoxImageKey,
  peonId: Schema.String,
  tokens: Schema.Int,
});

export interface SpendAlarm {
  readonly day: number;
  readonly peonId: string;
  readonly metric: "daily" | "rate";
  readonly used: number;
  readonly limit: number;
}

const unavailable = () =>
  refusal(
    "The host spend ledger is unavailable; forwarding could spend unaccounted quota. Inspect manager storage and retry promptPeon.",
    503
  );

const statements = (db: DatabaseSync) => {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS spend_request (
      receipt TEXT PRIMARY KEY, peonId TEXT NOT NULL, day INTEGER NOT NULL,
      began INTEGER NOT NULL, tokens INTEGER NOT NULL, imageKey TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS spend_rate ON spend_request(peonId, began);
    CREATE INDEX IF NOT EXISTS spend_request_day ON spend_request(day);
    CREATE TABLE IF NOT EXISTS spend_day (
      day INTEGER NOT NULL, peonId TEXT NOT NULL, tokens INTEGER NOT NULL,
      PRIMARY KEY(day, peonId)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS spend_alarm (
      day INTEGER NOT NULL, peonId TEXT NOT NULL, metric TEXT NOT NULL,
      PRIMARY KEY(day, peonId, metric)
    ) STRICT;
  `);

  return {
    alarm: db.prepare("INSERT OR IGNORE INTO spend_alarm VALUES (?, ?, ?)"),
    charge: db.prepare(`
      INSERT INTO spend_day VALUES (?, ?, ?)
      ON CONFLICT(day, peonId) DO UPDATE SET tokens = tokens + excluded.tokens
      RETURNING tokens
    `),
    daily: db.prepare(
      "SELECT tokens FROM spend_day WHERE day = ? AND peonId = ?"
    ),
    insert: db.prepare("INSERT INTO spend_request VALUES (?, ?, ?, ?, ?, ?)"),
    rate: db.prepare(
      "SELECT count(*) AS tokens FROM spend_request WHERE peonId = ? AND began > ?"
    ),
    request: db.prepare(
      "SELECT day, imageKey, peonId, tokens FROM spend_request WHERE receipt = ?"
    ),
    update: db.prepare("UPDATE spend_request SET tokens = ? WHERE receipt = ?"),
    pruneRequests: db.prepare("DELETE FROM spend_request WHERE day < ?"),
    pruneDays: db.prepare("DELETE FROM spend_day WHERE day < ?"),
    pruneAlarms: db.prepare("DELETE FROM spend_alarm WHERE day < ?"),
  };
};

const countOf = Schema.decodeUnknownSync(CounterRow);

const requestOf = Schema.decodeUnknownSync(StoredRequest);

export class SpendLedger extends Context.Service<
  SpendLedger,
  {
    readonly admit: (
      owner: BoxOwner,
      tokens: number
    ) => Effect.Effect<SpendAdmissionResult, BridgeFailure>;
    readonly record: (
      reading: typeof SpendReading.Type
    ) => Effect.Effect<void, BridgeFailure>;
  }
>()("@mischief/workspace-bridge/SpendLedger") {
  static readonly layer = (
    file: string,
    limits: SpendLimitsConfig,
    notify: (alarm: SpendAlarm) => Effect.Effect<void>
  ) =>
    Layer.effect(
      SpendLedger,
      Effect.gen(function* makeSpendLedger() {
        const db = yield* Effect.acquireRelease(
          Effect.try({ try: () => new DatabaseSync(file), catch: unavailable }),
          (database) =>
            Effect.sync(() => {
              database.close();
            })
        );

        const random = yield* SecureRandom.SecureRandom;

        const sql = yield* Effect.try({
          try: () => statements(db),
          catch: unavailable,
        });

        let prunedAt = -1;

        const transaction = <A>(
          run: (now: number, day: number, alarms: SpendAlarm[]) => A
        ) =>
          Effect.gen(function* spendTransaction() {
            const now = yield* Clock.currentTimeMillis;
            const day = Math.floor(now / DAY);
            const alarms: SpendAlarm[] = [];

            const result = yield* Effect.try({
              catch: unavailable,
              try: () => {
                db.exec("BEGIN IMMEDIATE");

                try {
                  if (day > prunedAt) {
                    sql.pruneRequests.run(day - 1);
                    sql.pruneDays.run(day - 1);
                    sql.pruneAlarms.run(day - 1);
                  }

                  const value = run(now, day, alarms);
                  db.exec("COMMIT");
                  prunedAt = Math.max(prunedAt, day);

                  return value;
                } catch (error) {
                  db.exec("ROLLBACK");
                  throw error;
                }
              },
            });

            for (const alarm of alarms) {
              yield* notify(alarm);
            }

            return result;
          }).pipe(Effect.uninterruptible);

        const warn = (alarm: SpendAlarm, alarms: SpendAlarm[]) => {
          if (
            alarm.used >= Math.ceil(alarm.limit * 0.8) &&
            sql.alarm.run(alarm.day, alarm.peonId, alarm.metric).changes > 0
          ) {
            alarms.push(alarm);
          }
        };

        const admit = Effect.fn("SpendLedger.admit")(function* admit(
          owner: BoxOwner,
          tokens: number
        ) {
          const cap = limits[owner.imageKey];

          if (cap === undefined) {
            return { status: "uncapped" } as const;
          }

          const { peonId } = owner;
          const receipt = yield* random.uuidV4();

          return yield* transaction<SpendAdmissionResult>(
            (now, day, alarms) => {
              const used = sql.daily.get(day, peonId);
              const total = used === undefined ? 0 : countOf(used).tokens;

              if (
                total >= cap.dailyTokens ||
                tokens > cap.dailyTokens - total
              ) {
                return { status: "denied", reason: "daily" };
              }

              const rate = countOf(sql.rate.get(peonId, now - MINUTE)).tokens;

              if (rate >= cap.ratePerMin) {
                return { status: "denied", reason: "rate" };
              }

              sql.insert.run(receipt, peonId, day, now, tokens, owner.imageKey);
              sql.charge.get(day, peonId, tokens);
              warn(
                {
                  day,
                  peonId,
                  metric: "rate",
                  used: rate + 1,
                  limit: cap.ratePerMin,
                },
                alarms
              );
              warn(
                {
                  day,
                  peonId,
                  metric: "daily",
                  used: total + tokens,
                  limit: cap.dailyTokens,
                },
                alarms
              );

              return { status: "metered", receipt };
            }
          );
        });

        const record = Effect.fn("SpendLedger.record")(function* record(
          reading: typeof SpendReading.Type
        ) {
          const found = yield* transaction((_now, _day, alarms) => {
            const row = sql.request.get(reading.receipt);

            if (row === undefined) {
              return false;
            }

            const request = requestOf(row);

            if (reading.tokens <= request.tokens) {
              return true;
            }

            sql.update.run(reading.tokens, reading.receipt);
            const { day, peonId } = request;

            const total = countOf(
              sql.charge.get(day, peonId, reading.tokens - request.tokens)
            ).tokens;

            const cap = limits[request.imageKey];

            if (cap !== undefined) {
              warn(
                {
                  day,
                  peonId,
                  metric: "daily",
                  used: total,
                  limit: cap.dailyTokens,
                },
                alarms
              );
            }

            return true;
          });

          if (!found) {
            return yield* refusal(
              "The stream's admission is missing from the host ledger. Inspect the ledger before retrying promptPeon.",
              503
            );
          }

          return yield* Effect.void;
        });

        return SpendLedger.of({ admit, record });
      })
    ).pipe(Layer.provide(SecureRandom.layerWebCrypto));
}
