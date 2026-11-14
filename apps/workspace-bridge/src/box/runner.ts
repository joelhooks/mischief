import { Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { refusal } from "../protocol.js";
import { collectBytes, Runner } from "../runner.js";
import type { Command } from "../runner.js";

export const boxRunnerLayer = (searchPath?: string) =>
  Layer.effect(
    Runner,
    Effect.gen(function* makeBoxRunner() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = Effect.fn("BoxRunner.run")(
        function* run(command: Command) {
          const child = yield* spawner.spawn(
            ChildProcess.make(command.executable, command.args, {
              env:
                searchPath === undefined
                  ? { GIT_TERMINAL_PROMPT: "0", LANG: "C.UTF-8" }
                  : {
                      GIT_TERMINAL_PROMPT: "0",
                      LANG: "C.UTF-8",
                      PATH: searchPath,
                    },
              extendEnv: true,
              stdin:
                command.input === undefined
                  ? "ignore"
                  : Stream.make(new TextEncoder().encode(command.input)),
            })
          );

          const [bytes, , exit] = yield* Effect.all(
            [
              collectBytes(child.stdout, 16 * 1024 * 1024),
              collectBytes(child.stderr, 64 * 1024),
              child.exitCode,
            ],
            { concurrency: "unbounded" }
          );

          return {
            exit: Number(exit),
            stdout: new TextDecoder().decode(bytes),
          };
        },
        Effect.scoped,
        Effect.catchTag("PlatformError", () =>
          Effect.fail(
            refusal(
              "Box host command could not start. Check git, tar, sha256sum and the Docker socket, then retry the box operation.",
              503
            )
          )
        )
      );

      return Runner.of({ run });
    })
  );
