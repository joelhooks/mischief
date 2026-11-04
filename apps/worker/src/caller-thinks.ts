import type { SqlStorage } from "@mischief/plan-run";
import { Result, Schema } from "effect";

export const DEFAULT_CALLER_THINKS = 40;

export const CALLER_RETRY_MS = 30_000;

export class CallerThinksRefused extends Schema.TaggedError<CallerThinksRefused>()(
  "CallerThinksRefused",
  { given: Schema.String }
) {
  override get message() {
    return `MISCHIEF_CALLER_THINKS="${this.given}" is refused: it protects other callers' model capacity, so it must be a positive whole number such as ${DEFAULT_CALLER_THINKS}. Set MISCHIEF_CALLER_THINKS=${DEFAULT_CALLER_THINKS}, or leave it unset for the default of ${DEFAULT_CALLER_THINKS}, then start the host again`;
  }
}

export const callerThinksFrom = (text?: string) => {
  const given = (text ?? "").trim();

  if (given === "") {
    return Result.succeed(DEFAULT_CALLER_THINKS);
  }

  return /^[1-9]\d*$/u.test(given) && Number.isSafeInteger(Number(given))
    ? Result.succeed(Number(given))
    : Result.fail(new CallerThinksRefused({ given }));
};

const Lease = Schema.Struct({ expires: Schema.Finite });

const Count = Schema.Struct({ count: Schema.Int });

const Crossing = Schema.Struct({
  quiet_until: Schema.Finite,
  serial: Schema.Int,
});

export const ShareNotice = Schema.Struct({
  object_name: Schema.String,
  serial: Schema.Int,
  text: Schema.String,
  to: Schema.String,
});

export const callerThinkLedger = (storage: SqlStorage) => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS caller_think_leases (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)"
  );
  storage.sql.exec(
    "CREATE INDEX IF NOT EXISTS caller_think_expiry ON caller_think_leases (expires)"
  );
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS caller_think_crossing (id INTEGER PRIMARY KEY CHECK (id = 1), quiet_until INTEGER NOT NULL, serial INTEGER NOT NULL)"
  );
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS caller_think_notices (serial INTEGER NOT NULL, object_name TEXT NOT NULL, recipient TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (serial, recipient))"
  );

  return {
    acquire: (input: {
      readonly caller: string;
      readonly id: string;
      readonly now: number;
      readonly objectName: string;
      readonly share: number;
      readonly to: readonly string[];
      readonly ttlMs: number;
      readonly key: string;
    }) =>
      storage.transactionSync(() => {
        storage.sql.exec(
          "DELETE FROM caller_think_leases WHERE expires <= ?",
          input.now
        );

        const [existing] = storage.sql
          .exec(
            "SELECT expires FROM caller_think_leases WHERE id = ?",
            input.id
          )
          .toArray()
          .map((row) => Schema.decodeUnknownSync(Lease)(row));

        if (existing !== undefined) {
          return { acquired: true, expires: existing.expires };
        }

        const [count] = storage.sql
          .exec("SELECT COUNT(*) AS count FROM caller_think_leases")
          .toArray()
          .map((row) => Schema.decodeUnknownSync(Count)(row));

        if ((count?.count ?? 0) < input.share) {
          const expires = input.now + input.ttlMs;
          storage.sql.exec(
            "INSERT INTO caller_think_leases (id, expires) VALUES (?, ?)",
            input.id,
            expires
          );

          return { acquired: true, expires };
        }

        const [crossing] = storage.sql
          .exec(
            "SELECT quiet_until, serial FROM caller_think_crossing WHERE id = 1"
          )
          .toArray()
          .map((row) => Schema.decodeUnknownSync(Crossing)(row));

        const fresh =
          crossing === undefined || crossing.quiet_until <= input.now;

        const serial = (crossing?.serial ?? 0) + (fresh ? 1 : 0);
        storage.sql.exec(
          "INSERT INTO caller_think_crossing (id, quiet_until, serial) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET quiet_until = excluded.quiet_until, serial = excluded.serial",
          input.now + input.ttlMs,
          serial
        );

        if (fresh) {
          const text = `${input.caller} has reached its share of ${input.share} concurrent thinks across runs. ${input.objectName} step ${input.key} is waiting so other callers keep their model capacity. Nothing failed or was refused. The run's alarm retries automatically; inspectRun shows the caller-share hold. This is one notice for this crossing; another is sent only after a full lease period without a share wait.`;

          for (const to of new Set(input.to)) {
            storage.sql.exec(
              "INSERT INTO caller_think_notices (serial, object_name, recipient, text) VALUES (?, ?, ?, ?)",
              serial,
              input.objectName,
              to,
              text
            );
          }
        }

        return { acquired: false, expires: input.now + CALLER_RETRY_MS };
      }),
    pending: () =>
      storage.sql
        .exec(
          "SELECT serial, object_name, recipient AS `to`, text FROM caller_think_notices ORDER BY serial, recipient LIMIT 1"
        )
        .toArray()
        .map((row) => Schema.decodeUnknownSync(ShareNotice)(row))[0],
    release: (id: string) => {
      storage.sql.exec("DELETE FROM caller_think_leases WHERE id = ?", id);
    },
    sent: (serial: number, to: string) => {
      storage.sql.exec(
        "DELETE FROM caller_think_notices WHERE serial = ? AND recipient = ?",
        serial,
        to
      );
    },
  };
};
