import { DatabaseSync } from "node:sqlite";

import type { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Clock, Context, Effect, Layer, Queue, Schema } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";

import { refusal } from "../protocol.js";
import { BoxImageKey } from "./spend-protocol.js";
import type {
  BoxOwner,
  SpendAdmissionResult,
  SpendLimitsConfig,
  SpendProgress,
  SpendReading,
} from "./spend-protocol.js";

const MINUTE = 60_000;

const DAY = 86_400_000;

const DEFAULT_OUTPUT_TOKENS = 32_000;

const Count = Schema.Struct({ tokens: Schema.Int });

const Totals = Schema.Struct({ tokens: Schema.Int, observed: Schema.Int });

const StoredRequest = Schema.Struct({
  day: Schema.Int,
  imageKey: BoxImageKey,
  peonId: Schema.String,
  tokens: Schema.Int,
  observed: Schema.Int,
  settled: Schema.Literals([0, 1]),
});

const Alarm = Schema.Struct({
  day: Schema.Int,
  peonId: Schema.String,
  metric: Schema.Literals(["daily", "rate"]),
  used: Schema.Int,
  limit: Schema.Int,
});

const OutboxRow = Schema.Struct({
  ...Alarm.fields,
  logged: Schema.Literals([0, 1]),
});

export type SpendAlarm = typeof Alarm.Type;

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
    CREATE TABLE IF NOT EXISTS spend_outbox (
      day INTEGER NOT NULL, peonId TEXT NOT NULL, metric TEXT NOT NULL,
      used INTEGER NOT NULL, cap INTEGER NOT NULL,
      logged INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, peonId, metric)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS spend_pending ON spend_outbox(sent, day, peonId, metric);
  `);

  const version = Schema.decodeUnknownSync(
    Schema.Struct({ user_version: Schema.Literals([0, 1]) })
  )(db.prepare("PRAGMA user_version").get());

  if (version.user_version === 0) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE spend_request ADD COLUMN observed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE spend_request ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE spend_day ADD COLUMN observed INTEGER NOT NULL DEFAULT 0;
      UPDATE spend_request SET observed = tokens, settled = 1;
      UPDATE spend_day SET observed = tokens;
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }

  return {
    alarm: db.prepare("INSERT OR IGNORE INTO spend_alarm VALUES (?, ?, ?)"),
    enqueue: db.prepare(
      "INSERT INTO spend_outbox(day, peonId, metric, used, cap) VALUES (?, ?, ?, ?, ?)"
    ),
    pending: db.prepare(
      "SELECT day, peonId, metric, used, cap AS 'limit', logged FROM spend_outbox WHERE sent = 0 ORDER BY day, peonId, metric LIMIT 1"
    ),
    logged: db.prepare(
      "UPDATE spend_outbox SET logged = 1 WHERE day = ? AND peonId = ? AND metric = ?"
    ),
    sent: db.prepare(
      "UPDATE spend_outbox SET sent = 1 WHERE day = ? AND peonId = ? AND metric = ?"
    ),
    charge: db.prepare(`
      INSERT INTO spend_day VALUES (?, ?, ?, ?)
      ON CONFLICT(day, peonId) DO UPDATE SET tokens = tokens + excluded.tokens, observed = observed + excluded.observed
      RETURNING tokens, observed
    `),
    daily: db.prepare(
      "SELECT tokens FROM spend_day WHERE day = ? AND peonId = ?"
    ),
    insert: db.prepare(
      "INSERT INTO spend_request VALUES (?, ?, ?, ?, ?, ?, ?, 0)"
    ),
    rate: db.prepare(
      "SELECT count(*) AS tokens FROM spend_request WHERE peonId = ? AND began > ?"
    ),
    request: db.prepare(
      "SELECT day, imageKey, peonId, tokens, observed, settled FROM spend_request WHERE receipt = ?"
    ),
    update: db.prepare(
      "UPDATE spend_request SET tokens = ?, observed = ?, settled = ? WHERE receipt = ?"
    ),
    pruneRequests: db.prepare("DELETE FROM spend_request WHERE day < ?"),
    pruneDays: db.prepare("DELETE FROM spend_day WHERE day < ?"),
    pruneAlarms: db.prepare("DELETE FROM spend_alarm WHERE day < ?"),
    pruneOutbox: db.prepare(
      "DELETE FROM spend_outbox WHERE sent = 1 AND day < ?"
    ),
  };
};

const countOf = Schema.decodeUnknownSync(Count);

const totalsOf = Schema.decodeUnknownSync(Totals);

const requestOf = Schema.decodeUnknownSync(StoredRequest);

const outboxOf = Schema.decodeUnknownSync(OutboxRow);

const sqlEffect = <A>(query: () => A) =>
  Effect.try({ try: query, catch: unavailable });

export class SpendLedger extends Context.Service<
  SpendLedger,
  {
    readonly admit: (
      owner: BoxOwner,
      tokens: number,
      outputTokens?: number
    ) => Effect.Effect<SpendAdmissionResult, BridgeFailure>;
    readonly record: (
      reading: typeof SpendReading.Type
    ) => Effect.Effect<typeof SpendProgress.Type, BridgeFailure>;
  }
>()("@mischief/workspace-bridge/SpendLedger") {
  static readonly layer = (
    file: string,
    limits: SpendLimitsConfig,
    send: (alarm: SpendAlarm) => Effect.Effect<void, BridgeFailure>,
    log: (alarm: SpendAlarm) => Effect.Effect<void> = () => Effect.void
  ) =>
    Layer.effect(
      SpendLedger,
      Effect.gen(function* makeSpendLedger() {
        const db = yield* Effect.acquireRelease(
          sqlEffect(() => new DatabaseSync(file)),
          (database) =>
            Effect.sync(() => {
              database.close();
            })
        );

        const random = yield* SecureRandom.SecureRandom;
        const sql = yield* sqlEffect(() => statements(db));
        const wake = yield* Queue.sliding<true>(1);
        let prunedAt = -1;

        const nextAlarm = sqlEffect(() => {
          const row = sql.pending.get();

          return row === undefined ? undefined : outboxOf(row);
        });

        const drain = Effect.gen(function* drainOutbox() {
          let next = yield* nextAlarm;

          while (next !== undefined) {
            const { logged, ...alarm } = next;
            const { day, peonId, metric } = alarm;

            if (logged === 0) {
              yield* log(alarm).pipe(
                Effect.andThen(
                  sqlEffect(() => sql.logged.run(day, peonId, metric))
                )
              );
            }

            yield* Effect.uninterruptibleMask((restore) =>
              restore(send(alarm)).pipe(
                Effect.andThen(
                  sqlEffect(() => sql.sent.run(day, peonId, metric))
                )
              )
            );
            next = yield* nextAlarm;
          }
        });

        yield* Effect.forever(
          Queue.take(wake).pipe(
            Effect.andThen(drain),
            Effect.catch(() =>
              Effect.sleep("10 seconds").pipe(
                Effect.andThen(Queue.offer(wake, true))
              )
            )
          )
        ).pipe(Effect.forkScoped);
        yield* Queue.offer(wake, true);

        const transaction = <A>(run: (now: number, day: number) => A) =>
          Effect.gen(function* spendTransaction() {
            const now = yield* Clock.currentTimeMillis;
            const day = Math.floor(now / DAY);

            const result = yield* sqlEffect(() => {
              db.exec("BEGIN IMMEDIATE");

              try {
                if (day > prunedAt) {
                  sql.pruneRequests.run(day - 1);
                  sql.pruneDays.run(day - 1);
                  sql.pruneAlarms.run(day - 1);
                  sql.pruneOutbox.run(day - 1);
                }

                const value = run(now, day);
                db.exec("COMMIT");
                prunedAt = Math.max(prunedAt, day);

                return value;
              } catch (error) {
                db.exec("ROLLBACK");
                throw error;
              }
            });

            yield* Queue.offer(wake, true);

            return result;
          }).pipe(Effect.uninterruptible);

        const warn = ({ day, peonId, metric, used, limit }: SpendAlarm) => {
          if (
            used >= Math.ceil(limit * 0.8) &&
            sql.alarm.run(day, peonId, metric).changes > 0
          ) {
            sql.enqueue.run(day, peonId, metric, used, limit);
          }
        };

        const admit = Effect.fn("SpendLedger.admit")(function* admit(
          owner: BoxOwner,
          tokens: number,
          requested?: number
        ) {
          const cap = limits[owner.imageKey];

          if (cap === undefined) {
            return { status: "uncapped" } as const;
          }

          const outputTokens =
            requested ?? cap.defaultOutputTokens ?? DEFAULT_OUTPUT_TOKENS;

          const { peonId } = owner;
          const receipt = yield* random.uuidV4();

          return yield* transaction<SpendAdmissionResult>((now, day) => {
            const row = sql.daily.get(day, peonId);
            const used = row === undefined ? 0 : countOf(row).tokens;

            if (outputTokens > cap.dailyTokens - used - tokens) {
              return { status: "denied", reason: "daily" };
            }

            const rate = countOf(sql.rate.get(peonId, now - MINUTE)).tokens;

            if (rate >= cap.ratePerMin) {
              return { status: "denied", reason: "rate" };
            }

            const reserved = tokens + outputTokens;
            sql.insert.run(
              receipt,
              peonId,
              day,
              now,
              reserved,
              owner.imageKey,
              tokens
            );

            const totals = totalsOf(
              sql.charge.get(day, peonId, reserved, tokens)
            );

            warn({
              day,
              peonId,
              metric: "rate",
              used: rate + 1,
              limit: cap.ratePerMin,
            });
            warn({
              day,
              peonId,
              metric: "daily",
              used: totals.observed,
              limit: cap.dailyTokens,
            });

            return { status: "metered", receipt, outputTokens };
          });
        });

        const record = Effect.fn("SpendLedger.record")(function* record(
          reading: typeof SpendReading.Type
        ) {
          const result = yield* transaction((_now, _day) => {
            const row = sql.request.get(reading.receipt);

            if (row === undefined) {
              return null;
            }

            const request = requestOf(row);
            const { day, peonId } = request;

            const reported =
              reading.settled === true
                ? reading.tokens
                : Math.max(reading.tokens, request.observed);

            const observed =
              request.settled === 1 ? request.observed : reported;

            const settled = request.settled === 1 || reading.settled === true;

            const charged = settled
              ? observed
              : Math.max(observed, request.tokens);

            const totals = totalsOf(
              sql.charge.get(
                day,
                peonId,
                charged - request.tokens,
                observed - request.observed
              )
            );

            sql.update.run(charged, observed, settled ? 1 : 0, reading.receipt);
            const cap = limits[request.imageKey];

            if (cap !== undefined) {
              warn({
                day,
                peonId,
                metric: "daily",
                used: totals.observed,
                limit: cap.dailyTokens,
              });
            }

            return {
              allowed:
                cap === undefined ||
                totals.tokens - cap.dailyTokens <=
                  Math.floor(cap.dailyTokens / 10),
            };
          });

          if (result === null) {
            return yield* refusal(
              "The stream's admission is missing from the host ledger. Inspect the ledger before retrying promptPeon.",
              503
            );
          }

          return result;
        });

        return SpendLedger.of({ admit, record });
      })
    ).pipe(Layer.provide(SecureRandom.layerWebCrypto));
}
