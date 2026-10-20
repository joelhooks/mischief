// @effect-diagnostics nodeBuiltinImport:off -- This test reads the real lockfile from disk.
import { readFileSync } from "node:fs";

import { expect, it } from "@effect/vitest";
import { Schema } from "effect";

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

it("fails on the real lockfile with one selector removed, naming key and path", () => {
  const real = readFileSync(
    new URL("../../../pnpm-lock.yaml", import.meta.url),
    "utf-8"
  );

  expect(findStrippedSelectors(real)).toEqual([]);
  const plant = real.replace("path: /packages/alchemy-nest, ", "");
  expect(plant).not.toBe(real);
  const found = findStrippedSelectors(plant);
  expect(found.map(({ path }) => path)).toEqual(["/packages/alchemy-nest"]);
  expect(refusal(found)).toContain("@rat-king/alchemy-nest");
  expect(refusal(found)).toContain("05e018f");
});
