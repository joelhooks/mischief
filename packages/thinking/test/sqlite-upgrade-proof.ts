// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- This offline migration proof launches the same fixture writer under two installed pi-durable versions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";

const [legacyRoot] = process.argv.slice(2);

assert.ok(
  legacyRoot !== undefined && legacyRoot.length > 0,
  "Pass the package directory of an installed @earendil-works/pi-durable@1.1.0 as the first argument"
);

Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.Literal("1.1.0") }))
)(await readFile(path.resolve(legacyRoot, "package.json"), "utf-8"));

const dir = await mkdtemp(path.join(tmpdir(), "mischief-sqlite-upgrade-"));

const original = path.join(dir, "original.sqlite");

const migrated = path.join(dir, "migrated.sqlite");

const expected = path.join(dir, "expected.json");

const fixture = path.join(import.meta.dirname, "sqlite-upgrade-fixture.ts");

const legacyFixture = path.join(dir, "sqlite-upgrade-fixture.ts");

await copyFile(fixture, legacyFixture);

await symlink(
  path.dirname(path.dirname(await realpath(legacyRoot))),
  path.join(dir, "node_modules"),
  "dir"
);

const runFixture = (runner: string, mode: string, file: string) =>
  execFileSync(process.execPath, [runner, mode, file, expected], {
    stdio: "inherit",
  });

runFixture(legacyFixture, "seed", original);

const versionOf = (file: string) => {
  const database = new DatabaseSync(file, { readOnly: true });

  try {
    return Schema.decodeUnknownSync(Schema.Struct({ version: Schema.Int }))(
      database
        .prepare("SELECT version FROM durable_schema WHERE singleton = 1")
        .get()
    ).version;
  } finally {
    database.close();
  }
};

const digestOf = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

assert.equal(versionOf(original), 1);

const originalDigest = await digestOf(original);

await copyFile(original, migrated);

runFixture(fixture, "verify", migrated);

assert.equal(versionOf(migrated), 2);

assert.equal(await digestOf(original), originalDigest);

assert.equal(versionOf(original), 1);

runFixture(legacyFixture, "verify", original);

runFixture(legacyFixture, "reject-v2", migrated);

assert.equal(await digestOf(original), originalDigest);

process.stdout.write(
  `${JSON.stringify({
    migratedVersion: versionOf(migrated),
    originalUnchanged: true,
    originalVersion: versionOf(original),
    preserved: ["conversation", "entry", "task", "mischief.steps"],
    rollback: "1.1.0 opens the original and rejects the migrated copy",
  })}\n`
);
