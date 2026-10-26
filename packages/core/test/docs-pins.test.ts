import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

const repoRoot = `${import.meta.dirname}/../../..`;

const docs = ["AGENTS.md", "README.md"];

const Dependencies = Schema.optional(
  Schema.Record(Schema.String, Schema.String)
);

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      dependencies: Dependencies,
      devDependencies: Dependencies,
    })
  )
);

const workspaceManifests = Effect.gen(function* workspaceManifests() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found = ["package.json"];

  for (const group of ["apps", "packages"]) {
    for (const name of yield* fs.readDirectory(path.join(repoRoot, group))) {
      const manifest = `${group}/${name}/package.json`;

      if (yield* fs.exists(path.join(repoRoot, manifest))) {
        found.push(manifest);
      }
    }
  }

  return found;
});

const prereleasePins = Effect.gen(function* prereleasePins() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pins: string[] = [];

  for (const manifest of yield* workspaceManifests) {
    const { dependencies, devDependencies } = decodeManifest(
      yield* fs.readFileString(path.join(repoRoot, manifest))
    );

    pins.push(...Object.values({ ...devDependencies, ...dependencies }));
  }

  return [
    ...new Set(pins.filter((version) => /^\d+\.\d+\.\d+-/u.test(version))),
  ];
});

const releaseLineOf = (version: string) => version.replace(/\d+$/u, "");

const escapeRegex = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const documentedMentions = (line: string) =>
  Effect.gen(function* mentionsGen() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pattern = new RegExp(`\`(${escapeRegex(line)}\\d+)\``, "gu");
    const found: { doc: string; version: string }[] = [];

    for (const doc of docs) {
      const text = yield* fs.readFileString(path.join(repoRoot, doc));

      for (const match of text.matchAll(pattern)) {
        found.push({ doc, version: match[1] ?? "" });
      }
    }

    return found;
  });

describe("documented versions", () => {
  it.effect(
    "match the pinned prerelease versions in the workspace manifests",
    () =>
      Effect.gen(function* matchPins() {
        const checks: {
          mentions: { doc: string; version: string }[];
          pinned: string;
        }[] = [];

        for (const pinned of yield* prereleasePins) {
          checks.push({
            mentions: yield* documentedMentions(releaseLineOf(pinned)),
            pinned,
          });
        }

        const stale = checks.flatMap(({ mentions, pinned }) =>
          mentions
            .filter((mention) => mention.version !== pinned)
            .map(
              (mention) =>
                `${mention.doc}: ${mention.version}, pinned ${pinned}`
            )
        );

        expect(
          checks.flatMap(({ mentions }) => mentions).length
        ).toBeGreaterThan(0);
        expect(stale).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer))
  );
});
