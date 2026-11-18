import type { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { refusal } from "./protocol.js";
import { collectBytes } from "./runner.js";

const Receipt = Schema.Struct({
  messageId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.String,
  permanent: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  ready: Schema.optional(Schema.Boolean),
  reason: Schema.NullOr(Schema.String),
  result: Schema.Literals(["restored", "alreadyLive", "refused", "failed"]),
});

export type RestoreReceipt = typeof Receipt.Type;

export class Restore extends Context.Service<
  Restore,
  {
    readonly run: (
      name: string,
      messageId?: string
    ) => Effect.Effect<RestoreReceipt, BridgeFailure>;
  }
>()("@mischief/workspace-bridge/DeskRestore") {}

export const RestoreArgv = Schema.fromJsonString(
  Schema.NonEmptyArray(Schema.String.check(Schema.isMinLength(1)))
);

type Argv = typeof RestoreArgv.Type;

const expectedExit = { alreadyLive: 0, failed: 1, refused: 2, restored: 0 };

const STDERR_TAIL = 1024;

const safeSshHints = [
  "Permission denied (publickey)",
  "Host key verification failed",
  "REMOTE HOST IDENTIFICATION HAS CHANGED",
  "Connection timed out",
  "Connection refused",
  "Could not resolve hostname",
  "Connection reset by peer",
];

const redactStderr = (tail: string) => {
  const hints = safeSshHints.filter((hint) => tail.includes(hint));

  return hints.length === 0 ? "[stderr redacted]" : hints.join("; ");
};

const stderrTail = <E>(stream: Stream.Stream<Uint8Array, E>) => {
  const decoder = new TextDecoder();

  return Stream.runFold(
    stream,
    () => "",
    (tail, chunk) =>
      (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL)
  );
};

export const restoreCommand = (
  [executable, ...configured]: Argv,
  exitMinutes: number
) =>
  Layer.effect(
    Restore,
    Effect.gen(function* makeRestoreCommand() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = Effect.fn("DeskRestore.run")(
        function* runRestore(name: string, messageId?: string) {
          const dryRun = messageId === undefined;

          const extra = dryRun
            ? ["--dry-run", "--name", name]
            : [
                "--name",
                name,
                "--message-id",
                messageId,
                "--exit-when-drained",
                String(exitMinutes),
              ];

          const child = yield* spawner.spawn(
            ChildProcess.make(executable, [...configured, ...extra], {
              env: {
                LANG: "C.UTF-8",
                PATH: "/usr/local/bin:/usr/bin:/bin",
                RATKING_EXIT_WHEN_DRAINED: String(exitMinutes),
              },
              extendEnv: false,
              forceKillAfter: "2 seconds",
              stdin: "ignore",
            })
          );

          const [stdout, stderr, exit] = yield* Effect.all(
            [
              collectBytes(child.stdout, 16 * 1024),
              stderrTail(child.stderr),
              child.exitCode,
            ],
            { concurrency: "unbounded" }
          );

          if (exit !== 0 && exit !== 1 && exit !== 2) {
            return yield* refusal(
              `Restore transport exited ${exit}: ${redactStderr(stderr)}. Check the configured argv and the remote restore journal.`,
              502
            );
          }

          const line = new TextDecoder().decode(stdout).trim();

          const receipt = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Receipt)
          )(line).pipe(
            Effect.mapError(() =>
              refusal(
                `Restore exited ${exit} without a valid receipt: ${redactStderr(stderr)}. Check MISCHIEF_DESK_RESTORE_CMD and retry.`,
                502
              )
            )
          );

          if (
            line.includes("\n") ||
            expectedExit[receipt.result] !== exit ||
            receipt.name !== name ||
            (!dryRun && receipt.messageId !== messageId)
          ) {
            return yield* refusal(
              "Restore receipt did not match the command exit, desk or message id. Check the Muster version and retry.",
              502
            );
          }

          return receipt;
        },
        Effect.scoped,
        (effect, _name, messageId) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: messageId === undefined ? "15 seconds" : "150 seconds",
              orElse: () =>
                Effect.fail(
                  refusal(
                    "Desk restore command timed out. Inspect the remote Muster journal and retry the same message id.",
                    502
                  )
                ),
            })
          ),
        Effect.catchTag("PlatformError", () =>
          Effect.fail(
            refusal(
              "Desk restore command could not start. Check MISCHIEF_DESK_RESTORE_CMD and retry.",
              502
            )
          )
        )
      );

      return Restore.of({ run });
    })
  );
