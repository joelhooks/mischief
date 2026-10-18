import { DriveLeaseSchema } from "@mischief/core";
import type { DriveLease } from "@mischief/core";
import { Option, Schema } from "effect";

import { DriveLeaseLost } from "./drive-lease-lost.js";
import type { SqlStorage } from "./sql.js";

const decode = Schema.decodeUnknownSync(DriveLeaseSchema);

export const driveLease = (storage: SqlStorage) => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS mischief_drive_lease (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL, holder TEXT, lease_until INTEGER NOT NULL)"
  );
  storage.sql.exec(
    "INSERT OR IGNORE INTO mischief_drive_lease VALUES (1, 0, NULL, 0)"
  );

  const peek = (): DriveLease =>
    decode(
      storage.sql
        .exec(
          "SELECT epoch, holder, lease_until AS leaseUntil FROM mischief_drive_lease WHERE id = 1"
        )
        .toArray()[0]
    );

  const take = (holder: string, now: number, ttl: number) =>
    storage.transactionSync(() => {
      const rows = storage.sql
        .exec(
          "UPDATE mischief_drive_lease SET epoch = epoch + 1, holder = ?, lease_until = ? WHERE id = 1 AND (holder IS NULL OR lease_until <= ?) RETURNING epoch, holder, lease_until AS leaseUntil",
          holder,
          now + ttl,
          now
        )
        .toArray();

      return rows.length === 0
        ? Option.none<DriveLease>()
        : Option.some(decode(rows[0]));
    });

  const renew = (lease: DriveLease, now: number, ttl: number) =>
    storage.sql
      .exec(
        "UPDATE mischief_drive_lease SET lease_until = ? WHERE id = 1 AND epoch = ? AND holder = ? AND lease_until > ? RETURNING epoch",
        now + ttl,
        lease.epoch,
        lease.holder,
        now
      )
      .toArray().length === 1;

  const release = (lease: DriveLease) => {
    storage.sql.exec(
      "UPDATE mischief_drive_lease SET holder = NULL, lease_until = 0 WHERE id = 1 AND epoch = ? AND holder = ?",
      lease.epoch,
      lease.holder
    );
  };

  const fenced = (lease: DriveLease): SqlStorage => ({
    sql: storage.sql,
    transactionSync: (write) =>
      storage.transactionSync(() => {
        const allowed =
          storage.sql
            .exec(
              "SELECT 1 FROM mischief_drive_lease WHERE id = 1 AND epoch = ? AND holder = ?",
              lease.epoch,
              lease.holder
            )
            .toArray().length === 1;

        if (!allowed) {
          throw new DriveLeaseLost({
            owner: lease.holder ?? "released",
            reason: `Drive epoch ${lease.epoch} no longer owns this run's storage. It wrote nothing; the current alarm holder will continue from the committed checkpoint. Poll inspectRun to see driveLease and progress.`,
          });
        }

        return write();
      }),
  });

  return { fenced, peek, release, renew, take };
};
