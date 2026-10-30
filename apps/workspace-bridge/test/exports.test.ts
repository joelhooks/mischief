import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";

import { decodeMirrors } from "../src/config.js";
import {
  Exports,
  EXPORT_TTL_MS,
  DISK_BUDGET,
  safePath,
} from "../src/exports.js";
import { checked, Runner } from "../src/runner.js";
import { sha } from "./fixtures.js";

it.effect(
  "mirror configuration refuses invalid repo names, credentials, foreign hosts and non-HTTPS URLs without echoing secrets",
  () =>
    Effect.gen(function* config() {
      for (const [repo, url] of [
        ["../escape", "https://git.example/repo"],
        ["owner/repo", "http://git.example/repo"],
        ["owner/repo", "https://other.example/repo"],
        ["owner/repo", "https://user:must-not-log@git.example/repo"],
        ["owner/repo", "https://git.example/repo?token=must-not-log"],
        ["owner/repo", "not a URL"],
      ]) {
        const failure = yield* Effect.flip(
          decodeMirrors(JSON.stringify({ [repo ?? ""]: url }), "git.example")
        );

        expect(failure.status).toBe(400);
        expect(failure.message).toContain("entry");
        expect(failure.message).not.toContain("must-not-log");
      }

      expect(
        yield* decodeMirrors(
          '{"owner/repo":"https://git.example/owner/repo"}',
          "git.example"
        )
      ).toEqual({ "owner/repo": "https://git.example/owner/repo" });
    })
);

it.effect(
  "bad sha and nonallowlisted repos are refused without fetching; disk overflow is unavailable",
  () =>
    Effect.gen(function* refusals() {
      const fs = yield* FileSystem.FileSystem;

      const root = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".workspace-test-",
      });

      const commands = yield* Ref.make<string[]>([]);

      const runner = Runner.of({
        run: (command) =>
          Ref.update(commands, (items) => [...items, command.executable]).pipe(
            Effect.as({ exit: 0, stdout: "1\tcache\n" })
          ),
      });

      yield* Effect.gen(function* service() {
        const exports = yield* Exports;
        expect(
          (yield* Effect.flip(
            exports.checkout({ repo: "owner/repo", sha: "main" })
          )).status
        ).toBe(400);
        expect(
          (yield* Effect.flip(exports.checkout({ repo: "other/repo", sha })))
            .status
        ).toBe(403);
        expect(yield* Ref.get(commands)).not.toContain("git");
      }).pipe(
        Effect.provide(
          Exports.layer({
            repos: { "owner/repo": "https://git.example/repo" },
            root,
          })
        ),
        Effect.provideService(Runner, runner)
      );

      const overflow = Runner.of({
        run: () =>
          Effect.succeed({ exit: 0, stdout: `${DISK_BUDGET + 1}\tcache\n` }),
      });

      const failure = yield* Effect.flip(
        Exports.use(({ gc }) => gc).pipe(
          Effect.provide(Exports.layer({ repos: {}, root })),
          Effect.provideService(Runner, overflow)
        )
      );

      expect(failure.message).toContain("50 GB");
      expect(failure).toMatchObject({ status: 503 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "real local Git archive exports the exact commit read-only, shares it, and GC respects active leases then expires it",
  () =>
    Effect.gen(function* gitArchive() {
      const fs = yield* FileSystem.FileSystem;

      const root = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".workspace-test-",
      });

      yield* Effect.addFinalizer(() =>
        checked({ args: ["-R", "u+w", root], executable: "chmod" }).pipe(
          Effect.orDie
        )
      );
      const source = `${root}/source`;
      yield* checked({ args: ["init", source], executable: "git" });
      yield* fs.writeFileString(`${source}/proof.txt`, "pinned contents\n");
      yield* checked({
        args: ["-C", source, "add", "proof.txt"],
        executable: "git",
      });
      yield* checked({
        args: [
          "-C",
          source,
          "-c",
          "user.name=fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "fixture",
        ],
        executable: "git",
      });

      const pinned = (yield* checked({
        args: ["-C", source, "rev-parse", "HEAD"],
        executable: "git",
      })).trim();

      yield* Effect.gen(function* service() {
        const exports = yield* Exports;
        const workspace = { repo: "owner/repo", sha: pinned };
        const first = yield* Effect.scoped(exports.checkout(workspace));
        expect(yield* fs.readFileString(`${first.path}/proof.txt`)).toBe(
          "pinned contents\n"
        );
        expect((yield* fs.stat(`${first.path}/proof.txt`)).mode % 0o1000).toBe(
          0o444
        );
        expect((yield* fs.stat(first.path)).mode % 0o1000).toBe(0o555);
        expect(first.digest).toMatch(/^[0-9a-f]{64}$/u);
        yield* fs.writeFileString(
          `${source}/proof.txt`,
          "uncommitted change\n"
        );
        const started = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();

        const lease = yield* Effect.forkChild(
          Effect.scoped(
            exports.checkout(workspace).pipe(
              Effect.tap((next) =>
                Effect.sync(() => {
                  expect(next).toEqual(first);
                })
              ),
              Effect.andThen(Deferred.succeed(started, true)),
              Effect.andThen(Deferred.await(release))
            )
          )
        );

        yield* Deferred.await(started);
        yield* TestClock.adjust(EXPORT_TTL_MS);
        yield* exports.gc;
        expect(yield* fs.exists(first.path)).toBe(true);
        yield* Deferred.succeed(release, true);
        yield* Fiber.join(lease);
        yield* exports.gc;
        expect(yield* fs.exists(first.path)).toBe(false);

        const absent = yield* Effect.flip(
          Effect.scoped(exports.checkout({ ...workspace, sha }))
        );

        expect(absent.status).toBe(400);
        const outside = `${root}/outside.json`;
        yield* fs.writeFileString(outside, "must remain unchanged");
        yield* fs.symlink(outside, `${root}/cache/metadata/${pinned}.json`);

        const metadataEscape = yield* Effect.flip(
          Effect.scoped(exports.checkout(workspace))
        );

        expect(metadataEscape.message).toContain("symlink");
        expect(yield* fs.readFileString(outside)).toBe("must remain unchanged");
        const escape = `${root}/symlink`;
        yield* fs.symlink(source, escape);
        expect((yield* Effect.flip(safePath(escape))).message).toContain(
          "symlink"
        );
      }).pipe(
        Effect.provide(
          Exports.layer({
            repos: { "owner/repo": source },
            root: `${root}/cache`,
          })
        )
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Runner.layer.pipe(Layer.provideMerge(NodeServices.layer)))
    )
);
