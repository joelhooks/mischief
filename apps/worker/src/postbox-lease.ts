import type { SqlStorage } from "@mischief/plan-run";
import { Option, Schema } from "effect";

const LEASE =
  "CREATE TABLE IF NOT EXISTS postbox_lease (id INTEGER PRIMARY KEY CHECK (id = 1), did TEXT NOT NULL, lease_id TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL)";

const Row = Schema.Struct({
  did: Schema.String,
  expires_at: Schema.Number,
  generation: Schema.Number,
  lease_id: Schema.String,
});

export interface HeldLease {
  readonly did: string;
  readonly expiresAt: number;
  readonly generation: number;
  readonly leaseId: string;
}

export interface LeaseBook {
  readonly held: (now: number) => Option.Option<HeldLease>;
  readonly save: (lease: HeldLease) => void;
}

export const leaseBook = (storage: SqlStorage): LeaseBook => {
  storage.sql.exec(LEASE);

  return {
    held: (now) =>
      Option.filter(
        Option.map(
          Option.fromNullishOr(
            storage.sql
              .exec(
                "SELECT did, lease_id, generation, expires_at FROM postbox_lease WHERE id = 1"
              )
              .toArray()[0]
          ),
          (row) => Schema.decodeUnknownOption(Row)(row)
        ).pipe(Option.flatten),
        (row) => row.expires_at > now
      ).pipe(
        Option.map((row) => ({
          did: row.did,
          expiresAt: row.expires_at,
          generation: row.generation,
          leaseId: row.lease_id,
        }))
      ),
    save: ({ did, expiresAt, generation, leaseId }) => {
      storage.sql.exec(
        "INSERT INTO postbox_lease (id, did, lease_id, generation, expires_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET did = excluded.did, lease_id = excluded.lease_id, generation = excluded.generation, expires_at = excluded.expires_at",
        did,
        leaseId,
        generation,
        expiresAt
      );
    },
  };
};
