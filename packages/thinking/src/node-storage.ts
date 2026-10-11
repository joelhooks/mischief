// @effect-diagnostics asyncFunction:off -- openNodeSqliteStorage is a Promise API at this adapter boundary.
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { StepFailed } from "@mischief/core";
import { Effect } from "effect";

export const nodeSqliteStorageFor =
  (root: string) =>
  (runId: string): Effect.Effect<Storage, StepFailed> =>
    Effect.tryPromise({
      catch: (cause) =>
        new StepFailed({
          key: "__thinking",
          reason: `could not open the thinking store for run ${runId} under ${root}: ${String(cause)}. Check that the directory exists and is writable, then resume the run`,
        }),
      try: async () =>
        await openNodeSqliteStorage(
          `${root}/${encodeURIComponent(runId)}.sqlite`
        ),
    });
