import type { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Context, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { refusal } from "./protocol.js";

export const OUTPUT_LIMIT = 16 * 1024 * 1024;

export interface Command {
  readonly args: readonly string[];
  readonly executable: string;
  readonly input?: string;
  readonly onStdout?: (chunk: Uint8Array) => Effect.Effect<void>;
}

export interface ProcessOutput {
  readonly exit: number;
  readonly stdout: string;
}

export const collectBytes = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  limit: number
) =>
  Effect.gen(function* collectOutput() {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    yield* Stream.runForEach(stream, (chunk) => {
      bytes += chunk.byteLength;

      if (bytes > limit) {
        return Effect.fail(
          refusal(
            "Workspace command exceeded its output cap. Reduce the request and resume the run.",
            502
          )
        );
      }

      chunks.push(chunk);

      return Effect.void;
    });
    const joined = new Uint8Array(bytes);
    let offset = 0;

    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return joined;
  });

const collect = <E>(stream: Stream.Stream<Uint8Array, E>, limit: number) =>
  collectBytes(stream, limit).pipe(
    Effect.map((bytes) => new TextDecoder().decode(bytes))
  );

export class Runner extends Context.Service<
  Runner,
  {
    readonly run: (
      command: Command
    ) => Effect.Effect<ProcessOutput, BridgeFailure>;
  }
>()("@mischief/workspace-bridge/Runner") {
  static readonly layer = Layer.effect(
    Runner,
    Effect.gen(function* makeRunner() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = Effect.fn("WorkspaceRunner.run")(
        function* run(command: Command) {
          const child = yield* spawner.spawn(
            ChildProcess.make(command.executable, command.args, {
              env: {
                GIT_TERMINAL_PROMPT: "0",
                LANG: "C.UTF-8",
                PATH: "/usr/local/bin:/usr/bin:/bin",
              },
              extendEnv: false,
              forceKillAfter: "2 seconds",
              stdin:
                command.input === undefined
                  ? "ignore"
                  : Stream.make(new TextEncoder().encode(command.input)),
            })
          );

          const [stdout, , exit] = yield* Effect.all(
            [
              collect(
                command.onStdout === undefined
                  ? child.stdout
                  : child.stdout.pipe(Stream.tap(command.onStdout)),
                OUTPUT_LIMIT
              ),
              collect(child.stderr, 64 * 1024),
              child.exitCode,
            ],
            { concurrency: "unbounded" }
          );

          return { exit: Number(exit), stdout };
        },
        Effect.scoped,
        Effect.catchTag("PlatformError", () =>
          Effect.fail(
            refusal(
              "Workspace command could not start. Check the host git, tar and Docker installation, then resume the run.",
              503
            )
          )
        )
      );

      return Runner.of({ run });
    })
  );
}

export const checked = (command: Command) =>
  Runner.use(({ run }) => run(command)).pipe(
    Effect.flatMap((output) =>
      output.exit === 0
        ? Effect.succeed(output.stdout)
        : Effect.fail(
            refusal(
              `Host ${command.executable} exited ${output.exit}. Check the allowlisted mirror and host installation, then retry the pinned sha.`,
              400
            )
          )
    )
  );
