import { DeskName, DeskWakeResult } from "@mischief/core/desk-wake";
import type { DeskLease } from "@mischief/core/desk-wake";
import type { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  Semaphore,
} from "effect";

import { Restore } from "./desk-restore.js";
import type { RestoreReceipt } from "./desk-restore.js";
import { refusal } from "./protocol.js";

const Receipt = Schema.Struct({
  name: DeskName,
  wake: Schema.NullOr(DeskWakeResult),
});

type Wake = typeof DeskWakeResult.Type;

const describe = (reason: string) =>
  reason
    .replaceAll(/[\r\n\t]+/gu, " ")
    .replaceAll(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .slice(0, 512);

const describeReceipt = ({ permanent, reason, result }: RestoreReceipt) => {
  const message = describe(reason ?? `Muster reported ${result}`);

  return permanent === undefined || permanent === null
    ? message
    : `${message} (Muster permanent=${permanent})`;
};

const resultOf = (receipt: RestoreReceipt) => {
  const reason = describeReceipt(receipt);
  const { ready, result } = receipt;

  if (result === "refused") {
    return DeskWakeResult.make({
      permanent: true,
      ready,
      reason,
      result: "failed",
    });
  }

  if (result === "failed" && receipt.reason === "wake in progress") {
    return DeskWakeResult.make({
      inProgress: true,
      ready,
      reason,
      result: "failed",
    });
  }

  return DeskWakeResult.make({
    ready,
    reason,
    result: result === "failed" ? "failed" : "restored",
  });
};

export class DeskHost extends Context.Service<
  DeskHost,
  {
    readonly lease: (
      name: string
    ) => Effect.Effect<typeof DeskLease.Type, BridgeFailure>;
    readonly wake: (
      name: string,
      messageId: string
    ) => Effect.Effect<Wake, BridgeFailure>;
  }
>()("@mischief/workspace-bridge/DeskHost") {
  static readonly layer = (receiptDir: string) =>
    Layer.effect(
      DeskHost,
      Effect.gen(function* deskHost() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const restore = yield* Restore;
        const lock = yield* Semaphore.make(1);

        if (
          !path.isAbsolute(receiptDir) ||
          path.normalize(receiptDir) !== receiptDir
        ) {
          return yield* refusal(
            "Desk wake receipts need a canonical absolute directory. Fix MISCHIEF_DESK_WAKE_RECEIPTS and restart the desk host.",
            503
          );
        }

        yield* fs.makeDirectory(receiptDir, { mode: 0o700, recursive: true });

        const lease = Effect.fn("DeskHost.lease")(function* leaseFor(
          name: string
        ) {
          const receipt = yield* restore.run(name);
          const { result } = receipt;

          if (result === "refused") {
            return {
              permanent: true as const,
              reason: describeReceipt(receipt),
            };
          }

          if (result === "failed") {
            return yield* refusal(
              `Muster could not check the desk lease: ${describeReceipt(receipt)}. Inspect the remote catalog and retry.`,
              502
            );
          }

          return { live: result === "alreadyLive" };
        });

        const writeReceipt = Effect.fn("DeskHost.writeReceipt")(
          function* writeReceipt(file: string, receipt: typeof Receipt.Type) {
            const content = yield* Schema.encodeEffect(
              Schema.fromJsonString(Receipt)
            )(receipt);

            const temporary = `${file}.tmp`;

            yield* Effect.scoped(
              Effect.gen(function* writeLocalReceipt() {
                const output = yield* fs.open(temporary, {
                  flag: "w",
                  mode: 0o600,
                });

                yield* output.writeAll(new TextEncoder().encode(content));
                yield* output.sync;
              })
            );
            yield* fs.rename(temporary, file);
          }
        );

        const performWake = Effect.fnUntraced(
          function* performWake(
            name: string,
            messageId: string,
            file: string,
            started: boolean
          ) {
            if (started) {
              return resultOf(yield* restore.run(name, messageId));
            }

            const probe = yield* restore.run(name);

            if (probe.result === "alreadyLive") {
              return DeskWakeResult.make({
                ready: probe.ready,
                reason: "Another reader already holds the desk lease.",
                result: "lost",
              });
            }

            if (probe.result !== "restored") {
              return resultOf(probe);
            }

            yield* writeReceipt(file, { name, wake: null });

            return resultOf(yield* restore.run(name, messageId));
          },
          Effect.catchTag("BridgeFailure", ({ message }) =>
            Effect.succeed(
              DeskWakeResult.make({
                reason: describe(message),
                result: "failed",
              })
            )
          )
        );

        const wake = Effect.fn("DeskHost.wake")(
          function* wakeFor(name: string, messageId: string) {
            const file = path.join(receiptDir, `${messageId}.json`);

            const prior = (yield* fs.exists(file))
              ? yield* Schema.decodeEffect(Schema.fromJsonString(Receipt))(
                  yield* fs.readFileString(file)
                )
              : null;

            if (prior !== null) {
              if (prior.name !== name) {
                return yield* refusal(
                  "This message id belongs to a different desk. Retry only with the original name or provide a fresh triggering message id.",
                  409
                );
              }

              if (prior.wake !== null) {
                return prior.wake;
              }
            }

            const result = yield* performWake(
              name,
              messageId,
              file,
              prior !== null
            );

            if (result.result !== "failed") {
              yield* writeReceipt(file, { name, wake: result });
            }

            return result;
          },
          (effect) => lock.withPermit(effect),
          Effect.catchTags({
            PlatformError: () =>
              Effect.fail(
                refusal(
                  "Desk wake receipt storage is unavailable. Check MISCHIEF_DESK_WAKE_RECEIPTS; do not change the message id when retrying.",
                  503
                )
              ),
            SchemaError: () =>
              Effect.fail(
                refusal(
                  "The desk wake receipt is invalid. Repair it from Muster's recorded receipt before retrying the same message id.",
                  503
                )
              ),
          })
        );

        return DeskHost.of({ lease, wake });
      })
    );
}
