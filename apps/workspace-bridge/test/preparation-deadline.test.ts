import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Ref,
  Result,
} from "effect";
import { TestClock } from "effect/testing";

import { DEADLINE_MS, runCall } from "../src/call-machine.js";
import { Exports } from "../src/exports.js";
import { Runner } from "../src/runner.js";
import { Sandbox } from "../src/sandbox.js";
import { image, request } from "./fixtures.js";

it.effect(
  "the 15 minute deadline interrupts mirror preparation too, before a container starts",
  () =>
    Effect.gen(function* preparation() {
      const fs = yield* FileSystem.FileSystem;

      const root = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".workspace-test-",
      });

      const started = yield* Deferred.make<boolean>();
      const stopped = yield* Ref.make(false);
      const containers = yield* Ref.make(0);

      const runner = Runner.of({
        run: (command) => {
          if (command.executable === "git") {
            return Deferred.succeed(started, true).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Ref.set(stopped, true))
            );
          }

          if (command.executable === "docker" && command.args[0] === "run") {
            return Ref.update(containers, (count) => count + 1).pipe(
              Effect.as({ exit: 0, stdout: "" })
            );
          }

          return Effect.succeed({
            exit: 0,
            stdout: command.executable === "du" ? "1\tcache\n" : "",
          });
        },
      });

      const runnerLayer = Layer.succeed(Runner, runner);

      const exports = Exports.layer({
        repos: { "example/review": "https://git.example/review" },
        root,
      }).pipe(Layer.provide(runnerLayer));

      const sandbox = Sandbox.layer(image).pipe(
        Layer.provide(exports),
        Layer.provide(runnerLayer)
      );

      const fiber = yield* Effect.forkChild(
        runCall(request).pipe(Effect.result, Effect.provide(sandbox))
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust(DEADLINE_MS);
      const result = yield* Fiber.join(fiber);
      expect(Result.isFailure(result)).toBe(true);

      if (Result.isFailure(result)) {
        expect(result.failure.status).toBe(504);
      }

      expect(yield* Ref.get(stopped)).toBe(true);
      expect(yield* Ref.get(containers)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
