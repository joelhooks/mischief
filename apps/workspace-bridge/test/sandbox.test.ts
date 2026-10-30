import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Ref,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";

import { runCall, DEADLINE_MS } from "../src/call-machine.js";
import { Exports, safePath } from "../src/exports.js";
import { Runner } from "../src/runner.js";
import type { Command } from "../src/runner.js";
import {
  ContainerName,
  Image,
  Sandbox,
  dockerArguments,
} from "../src/sandbox.js";
import { digest, image, name, piOutput, request, sha } from "./fixtures.js";

it.effect(
  "Servo argv: sha selects the read-only export; generated name enables teardown; thinking is a closed Pi enum; interactive carries bounded stdin; label enables crash sweep; init reaps children; daemon logging is disabled",
  () =>
    Effect.sync(() => {
      expect({
        args: dockerArguments(image, `/exports/${sha}`, name, "medium"),
        executable: "docker",
      }).toMatchSnapshot();
      expect(Schema.is(ContainerName)(name)).toBe(true);
      expect(Schema.is(ContainerName)("mischief-peon-../../other")).toBe(false);
      expect(Schema.is(Image)("image:latest")).toBe(false);
      expect(Schema.is(Image)(`--privileged@sha256:${digest}`)).toBe(false);
    })
);

const fixture = Effect.gen(function* fixture() {
  const fs = yield* FileSystem.FileSystem;

  const root = yield* fs.makeTempDirectoryScoped({
    directory: process.cwd(),
    prefix: ".workspace-test-",
  });

  const exported = `${root}/${sha}`;
  yield* fs.makeDirectory(exported);

  const exports = Exports.of({
    checkout: () => Effect.succeed({ digest, path: exported }),
    gc: Effect.void,
  });

  return { exported, exports, fs, root };
});

it.effect(
  "a fake Docker runner receives the reviewed argv, no prompt in argv, and exact-name teardown",
  () =>
    Effect.gen(function* argvSeam() {
      const context = yield* fixture;
      const commands = yield* Ref.make<Command[]>([]);

      const runner = Runner.of({
        run: (command) =>
          Ref.update(commands, (previous) => [...previous, command]).pipe(
            Effect.as({
              exit: 0,
              stdout: command.args[0] === "run" ? piOutput : "",
            })
          ),
      });

      const result = yield* Sandbox.use(({ run }) =>
        run({ ...request, reasoning: { effort: "max" } })
      ).pipe(
        Effect.provide(Sandbox.layer(image)),
        Effect.provideService(Exports, context.exports),
        Effect.provideService(Runner, runner)
      );

      expect(result.text).toBe("verdict");
      const recorded = yield* Ref.get(commands);
      const call = recorded.find((command) => command.args[0] === "run");
      expect(call).toBeDefined();

      if (call === undefined) {
        return yield* Effect.die("fake Docker did not receive a run");
      }

      const generated = call.args[call.args.indexOf("--name") + 1];
      expect(generated).toMatch(/^mischief-peon-[0-9a-f-]{36}$/u);
      expect(call.args[call.args.indexOf("--thinking") + 1]).toBe("high");
      expect(call.args).not.toContain("private review prompt");
      expect(call.input).toContain("private review prompt");
      expect(
        recorded.some(
          (command) => command.args.join(" ") === `rm --force ${generated}`
        )
      ).toBe(true);

      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "symlink exports, tool subsets, smaller token caps and oversized stdin are refused before Docker starts",
  () =>
    Effect.gen(function* refusals() {
      const context = yield* fixture;
      const link = `${context.root}/escape`;
      yield* context.fs.symlink(context.exported, link);
      expect((yield* Effect.flip(safePath(link))).message).toContain("symlink");
      const starts = yield* Ref.make(0);

      const runner = Runner.of({
        run: (command) =>
          command.args[0] === "run"
            ? Ref.update(starts, (count) => count + 1).pipe(
                Effect.as({ exit: 0, stdout: piOutput })
              )
            : Effect.succeed({ exit: 0, stdout: "" }),
      });

      const exports = Exports.of({
        ...context.exports,
        checkout: () => Effect.succeed({ digest, path: link }),
      });

      yield* Effect.gen(function* shared() {
        const sandbox = yield* Sandbox;

        const badTools = yield* Effect.flip(
          sandbox.run({ ...request, tools: ["read"] })
        );

        expect(badTools.status).toBe(400);

        const badCap = yield* Effect.flip(
          sandbox.run({ ...request, max_output_tokens: 16 })
        );

        expect(badCap.message).toContain("128000");
        const badLink = yield* Effect.flip(sandbox.run(request));
        expect(badLink.message).toContain("symlink");
        expect(yield* Ref.get(starts)).toBe(0);
      }).pipe(
        Effect.provide(Sandbox.layer(image)),
        Effect.provideService(Exports, exports),
        Effect.provideService(Runner, runner)
      );
      yield* Effect.gen(function* boundedInput() {
        const sandbox = yield* Sandbox;

        const tooLarge = yield* Effect.flip(
          sandbox.run({ ...request, instructions: "x".repeat(8 * 1024 * 1024) })
        );

        expect(tooLarge.status).toBe(413);
        expect(yield* Ref.get(starts)).toBe(0);
      }).pipe(
        Effect.provide(Sandbox.layer(image)),
        Effect.provideService(Exports, context.exports),
        Effect.provideService(Runner, runner)
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "deadline and client cancellation force-remove exactly their own container",
  () =>
    Effect.gen(function* deadline() {
      const context = yield* fixture;
      const commands = yield* Ref.make<Command[]>([]);
      const started = yield* Deferred.make<boolean>();

      const runner = Runner.of({
        run: (command) =>
          Ref.update(commands, (previous) => [...previous, command]).pipe(
            Effect.andThen(
              command.args[0] === "run"
                ? Deferred.succeed(started, true).pipe(
                    Effect.andThen(Effect.never)
                  )
                : Effect.succeed({ exit: 0, stdout: "" })
            )
          ),
      });

      const fiber = yield* Effect.forkChild(
        runCall(request).pipe(
          Effect.result,
          Effect.provide(Sandbox.layer(image)),
          Effect.provideService(Exports, context.exports),
          Effect.provideService(Runner, runner)
        )
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust(DEADLINE_MS - 1);
      expect(
        (yield* Ref.get(commands)).some((command) => command.args[0] === "rm")
      ).toBe(false);
      yield* TestClock.adjust(1);
      const outcome = yield* Fiber.join(fiber);
      expect(Result.isFailure(outcome)).toBe(true);

      if (Result.isFailure(outcome)) {
        expect(outcome.failure.status).toBe(504);
      }

      const recorded = yield* Ref.get(commands);
      const call = recorded.find((command) => command.args[0] === "run");
      const removed = recorded.find((command) => command.args[0] === "rm");
      expect(removed?.args[2]).toBe(
        call?.args[call.args.indexOf("--name") + 1]
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "boot orphan sweep removes labeled peons, and cache priming starts one leaf before followers",
  () =>
    Effect.gen(function* prime() {
      const context = yield* fixture;
      const starts = yield* Ref.make(0);
      const firstStarted = yield* Deferred.make<boolean>();
      const firstDone = yield* Deferred.make<boolean>();
      const firstExit = yield* Deferred.make<boolean>();
      const secondStarted = yield* Deferred.make<boolean>();
      const removed = yield* Ref.make<string[]>([]);

      const runner = Runner.of({
        run: (command) =>
          Effect.gen(function* fake() {
            if (command.args[0] === "ps") {
              return { exit: 0, stdout: "0123456789ab\n" };
            }

            if (command.args[0] === "inspect") {
              return { exit: 0, stdout: `/${name}\n` };
            }

            if (command.args[0] === "rm") {
              yield* Ref.update(removed, (names) => [
                ...names,
                command.args[2] ?? "",
              ]);

              return { exit: 0, stdout: "" };
            }

            const count = yield* Ref.updateAndGet(starts, (n) => n + 1);

            if (count === 1) {
              yield* Deferred.succeed(firstStarted, true);
              yield* Deferred.await(firstDone);

              if (command.onStdout !== undefined) {
                const encoded = new TextEncoder().encode(`${piOutput}\n`);
                yield* command.onStdout(encoded.slice(0, 30));
                yield* command.onStdout(encoded.slice(30));
              }

              yield* Deferred.await(firstExit);
            } else {
              yield* Deferred.succeed(secondStarted, true);
            }

            return { exit: 0, stdout: piOutput };
          }),
      });

      yield* Effect.gen(function* shared() {
        const sandbox = yield* Sandbox;
        expect(yield* Ref.get(removed)).toContain(name);
        const leader = yield* Effect.forkChild(sandbox.run(request));
        yield* Deferred.await(firstStarted);
        const follower = yield* Effect.forkChild(sandbox.run(request));
        yield* Effect.yieldNow;
        expect(yield* Ref.get(starts)).toBe(1);
        yield* Deferred.succeed(firstDone, true);
        yield* Deferred.await(secondStarted);
        expect(yield* Ref.get(starts)).toBe(2);
        yield* Deferred.succeed(firstExit, true);
        yield* Fiber.join(leader);
        yield* Fiber.join(follower);
        expect(yield* Ref.get(starts)).toBe(2);
      }).pipe(
        Effect.provide(Sandbox.layer(image)),
        Effect.provideService(Exports, context.exports),
        Effect.provideService(Runner, runner)
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
