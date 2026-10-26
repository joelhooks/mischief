import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";

import { findStrippedSelectors, refusal } from "../../../scripts/lock-paths.ts";

const Entry = Schema.Struct({
  carries: Schema.Boolean,
  path: Schema.NullOr(Schema.Literals(["/packages/a", "/packages/b/bundle"])),
});

const entryText = (entry: typeof Entry.Type, index: number): string => {
  const key =
    entry.path === null
      ? `pkg${index}@1.0.0`
      : `'@scope/pkg${index}@https://codeload.example/tar.gz/abc#path:${entry.path}'`;

  const field =
    entry.carries && entry.path !== null ? `path: ${entry.path}, ` : "";

  return `  ${key}:\n    resolution: {gitHosted: true, integrity: sha512-x, ${field}tarball: https://codeload.example/tar.gz/abc}\n    version: 1.0.0\n`;
};

const lockfileText = (entries: readonly (typeof Entry.Type)[]): string =>
  `lockfileVersion: '9.0'\n\npackages:\n\n${entries.map(entryText).join("\n")}\nsnapshots:\n\n  '@scope/pkg0@https://codeload.example/tar.gz/abc#path:/packages/a':\n    dependencies: {}\n`;

it.prop(
  "passes exactly when every #path key resolution carries the same path",
  [Schema.Array(Entry)],
  ([entries]) => {
    const expected = entries.flatMap((entry, index) =>
      entry.path !== null && !entry.carries ? [index] : []
    );

    const found = findStrippedSelectors(lockfileText(entries));
    expect(
      found.map(({ key }) => /pkg(?<n>\d+)@/u.exec(key)?.groups?.n)
    ).toEqual(expected.map(String));
  }
);

const lockfilePath = fileURLToPath(
  new URL("../../../pnpm-lock.yaml", import.meta.url)
);

const scriptPath = fileURLToPath(
  new URL("../../../scripts/lock-paths.ts", import.meta.url)
);

const STRIPPED = "path: /packages/alchemy-nest, ";

it.effect(
  "fails on the real lockfile with one selector removed, naming key and path",
  () =>
    Effect.gen(function* realLockfile() {
      const fs = yield* FileSystem.FileSystem;
      const real = yield* fs.readFileString(lockfilePath);

      expect(findStrippedSelectors(real)).toEqual([]);
      const plant = real.replace(STRIPPED, "");
      expect(plant).not.toBe(real);
      const found = findStrippedSelectors(plant);
      expect(found.map(({ path }) => path)).toEqual(["/packages/alchemy-nest"]);
      expect(refusal(found)).toContain("@rat-king/alchemy-nest");
      expect(refusal(found)).toContain("05e018f");
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "fails through a symlinked directory instead of silently passing",
  () =>
    Effect.gen(function* symlinked() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const real = yield* fs.readFileString(lockfilePath);

      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "lock-paths-",
      });

      const target = path.join(directory, "target");
      const link = path.join(directory, "link");
      yield* fs.makeDirectory(target);
      yield* fs.symlink(target, link);
      yield* fs.copyFile(scriptPath, path.join(target, "lock-paths.ts"));
      const stripped = path.join(directory, "stripped.yaml");
      yield* fs.writeFileString(stripped, real.replace(STRIPPED, ""));

      const child = yield* ChildProcess.make(
        "node",
        [path.join(link, "lock-paths.ts"), stripped],
        { stderr: "pipe", stdout: "pipe" }
      );

      const [stderr, code] = yield* Effect.all(
        [
          child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          child.exitCode,
        ],
        { concurrency: "unbounded" }
      );

      expect(Number(code)).toBe(1);
      expect(stderr).toContain("@rat-king/alchemy-nest");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
