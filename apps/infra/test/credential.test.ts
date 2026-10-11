import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { credentialScript } from "../credential.ts";

const NAME = "mischief_credential";

const REFUSED = "Credential binding refused; values redacted";

const PRINTABLE = ["a", "Z", "7", "-", "_", "~", "!"] as const;

const FLAWS = [" ", "\u0001", "é", "\u007F"] as const;

const Bindings = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.String)
);

const collect = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  Stream.mkString(Stream.decodeText(stream));

const host = Effect.fn("host")(function* host() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const bin = path.join(root, "bin");

  yield* fs.makeDirectory(bin);

  yield* fs.writeFileString(
    path.join(bin, "secrets"),
    `#!/bin/sh\n[ "$3" = "${NAME}" ] || exit 3\ncat "$LEASED"\n`,
    { mode: 0o755 }
  );

  const lease = (value: string) =>
    fs.writeFileString(path.join(root, "leased"), value);

  const run = Effect.fn("script")(function* script(
    action: string,
    directory: string,
    name = NAME
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "python3",
        ["-I", "-c", credentialScript, action, directory, name],
        {
          cwd: root,
          env: {
            LEASED: path.join(root, "leased"),
            PATH: `${bin}:/usr/bin:/bin`,
          },
        }
      )
    );

    return yield* Effect.all(
      {
        code: handle.exitCode,
        stderr: collect(handle.stderr),
        stdout: collect(handle.stdout),
      },
      { concurrency: "unbounded" }
    );
  });

  const modes = (directory: string) =>
    Effect.all([
      fs.stat(directory),
      fs.stat(path.join(directory, "bindings")),
    ]).pipe(
      Effect.map(([folder, file]) => [folder.mode % 0o1000, file.mode % 0o1000])
    );

  const bound = (directory: string) =>
    fs
      .readFileString(path.join(directory, "bindings"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Bindings)));

  return {
    bound,
    directory: path.join(root, "credential"),
    fs,
    lease,
    modes,
    path,
    root,
    run,
  };
});

it.effect.prop(
  "the host writes a leased credential only when it is at least 32 printable characters with no spaces, privately, and never echoes it",
  {
    chars: Arbitrary.schema(
      Schema.Array(Schema.Literals(PRINTABLE)).check(
        Schema.isMinLength(40),
        Schema.isMaxLength(40)
      )
    ),
    flaw: Arbitrary.schema(
      Schema.Option(
        Schema.Struct({
          at: Schema.Int.check(Schema.isBetween({ maximum: 40, minimum: 0 })),
          char: Schema.Literals(FLAWS),
        })
      )
    ),
    length: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 40, minimum: 24 }))
    ),
    padded: Arbitrary.schema(Schema.Boolean),
  },
  ({ chars, flaw, length, padded }) =>
    Effect.gen(function* property() {
      const core: string[] = [...chars].slice(0, length);

      const flawed = Option.match(flaw, {
        onNone: () => core,
        onSome: ({ at, char }) => core.toSpliced(at, 0, char),
      });

      const leased = padded ? ` ${flawed.join("")}\n` : flawed.join("");
      const trimmed = leased.replaceAll(/^ +|[ \n]+$/gu, "");
      const accepted = trimmed.length >= 32 && /^[!-~]+$/u.test(trimmed);
      const { bound, directory, fs, lease, modes, run } = yield* host();

      yield* lease(leased);

      expect((yield* run("observe", directory)).stdout.trim()).toBe("missing");

      const applied = yield* run("apply", directory);

      expect(["", REFUSED]).toContain(applied.stderr.trim());

      if (!accepted) {
        expect(applied.code).toBe(1);

        expect(yield* fs.exists(directory)).toBe(false);

        return;
      }

      expect(applied.code).toBe(0);

      expect(yield* bound(directory)).toStrictEqual({
        MISCHIEF_CREDENTIAL: trimmed,
      });

      expect(yield* modes(directory)).toStrictEqual([0o700, 0o600]);

      expect(yield* fs.readDirectory(directory)).toStrictEqual(["bindings"]);

      expect((yield* run("observe", directory)).stdout.trim()).toBe("ready");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 60 }, timeout: 120_000 }
);

it.effect(
  "the boundary is 32 characters, a lease's trailing newline is not part of it, and a widened file or folder is made private again",
  () =>
    Effect.gen(function* boundary() {
      const { bound, directory, fs, lease, modes, path, run } = yield* host();

      yield* lease(`${"k".repeat(31)}\n`);

      expect((yield* run("apply", directory)).code).toBe(1);

      yield* lease(`${"k".repeat(32)}\n`);

      yield* fs.makeDirectory(directory, { mode: 0o755 });

      yield* fs.chmod(directory, 0o755);

      expect((yield* run("apply", directory)).code).toBe(0);

      expect(yield* bound(directory)).toStrictEqual({
        MISCHIEF_CREDENTIAL: "k".repeat(32),
      });

      expect(yield* modes(directory)).toStrictEqual([0o700, 0o600]);

      yield* fs.chmod(path.join(directory, "bindings"), 0o644);

      expect((yield* run("observe", directory)).stdout.trim()).toBe("missing");

      expect((yield* run("apply", directory)).code).toBe(0);

      expect(yield* modes(directory)).toStrictEqual([0o700, 0o600]);

      expect((yield* run("observe", directory)).stdout.trim()).toBe("ready");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "the host refuses a symlinked bindings directory, a relative path, and leases only the named secret",
  () =>
    Effect.gen(function* refusals() {
      const { directory, fs, lease, path, root, run } = yield* host();
      const elsewhere = path.join(root, "elsewhere");

      yield* lease("x".repeat(40));

      yield* fs.makeDirectory(elsewhere, { mode: 0o700 });

      yield* fs.symlink(elsewhere, directory);

      expect((yield* run("apply", directory)).code).toBe(1);

      expect(yield* fs.readDirectory(elsewhere)).toStrictEqual([]);

      expect((yield* run("apply", "relative")).code).toBe(1);

      expect(yield* fs.exists(path.join(root, "relative"))).toBe(false);

      const fresh = path.join(root, "fresh");

      expect((yield* run("apply", fresh, "other_credential")).code).toBe(1);

      expect(yield* fs.exists(fresh)).toBe(false);

      expect((yield* run("apply", fresh)).code).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
