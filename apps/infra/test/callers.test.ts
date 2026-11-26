import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { callerReach } from "@mischief/core";
import { ConfigProvider, Effect, Exit, FileSystem, Path, Stream } from "effect";
import * as Digest from "effect/crypto/Digest";
import { ChildProcess } from "effect/process";

import { callersFromConfig } from "../callers.ts";
import { generateCallersFile } from "../generate-callers.ts";

const PUBLIC_JWK = {
  crv: "P-256",
  kty: "EC",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
};

const documentWith = (
  publicKeyJwk: Record<string, string>,
  id = "did:web:agent-graph.driver.pi.ratking-fleet.invalid"
) => ({
  authentication: [`${id}#atproto`],
  id,
  keyAgreement: [],
  verificationMethod: [
    {
      controller: id,
      id: `${id}#atproto`,
      publicKeyJwk,
    },
  ],
});

const loadCallers = (file: string) =>
  callersFromConfig.pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          MISCHIEF_CALLERS_FILE: file,
          MISCHIEF_DID: "did:web:mischief.example.invalid",
        })
      )
    )
  );

const callersFrom = (
  documents: readonly (ReturnType<typeof documentWith> & {
    readonly mischief?: {
      readonly mayMail?: readonly string[];
      readonly peonCapabilities?: readonly string[];
    };
  })[]
) =>
  Effect.gen(function* written() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = path.join(dir, "callers.json");

    yield* fs.writeFileString(file, JSON.stringify(documents));

    return yield* Effect.exit(loadCallers(file));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "a callers file holding a private key is refused with how to fix it, while public documents pass through unchanged",
  () =>
    Effect.gen(function* refused() {
      const leaked = yield* callersFrom([
        documentWith({ ...PUBLIC_JWK, d: "private-scalar" }),
      ]);

      expect(Exit.isFailure(leaked)).toBe(true);
      expect(String(Exit.isFailure(leaked) ? leaked.cause : "")).toMatch(
        /private key for did:web:agent-graph\.driver\.pi\.ratking-fleet\.invalid.*rotate/u
      );

      const clean = yield* callersFrom([documentWith(PUBLIC_JWK)]);
      expect(Exit.isSuccess(clean) ? clean.value.mailReach : "").toBe("{}");
      expect(Exit.isSuccess(clean) ? clean.value.peonGrants : "").toBe("{}");

      expect(Exit.isSuccess(clean) ? clean.value.callers : "").toBe(
        JSON.stringify([documentWith(PUBLIC_JWK)])
      );
    })
);

it.effect(
  "caller grants go only to the reach map, while omitted grants default to self and unknown DIDs fail closed",
  () =>
    Effect.gen(function* configured() {
      const doc = documentWith(PUBLIC_JWK);

      const other = documentWith(
        PUBLIC_JWK,
        "did:web:other.ratking-fleet.invalid"
      );

      const granted = yield* callersFrom([
        {
          ...doc,
          mischief: {
            mayMail: ["other/desk"],
            peonCapabilities: ["spawnPeon", "promptPeon", "armWatch"],
          },
        },
        other,
      ]);

      expect(Exit.isSuccess(granted)).toBe(true);

      if (Exit.isSuccess(granted)) {
        expect(JSON.parse(granted.value.mailReach)).toStrictEqual({
          [doc.id]: ["other/desk"],
        });
        expect(granted.value.callers).toBe(JSON.stringify([doc, other]));
        expect(JSON.parse(granted.value.peonGrants)).toStrictEqual({
          [doc.id]: ["spawnPeon", "promptPeon", "armWatch"],
        });
      }

      const invalid = yield* callersFrom([
        { ...doc, id: "did:web:unknown.example.invalid" },
      ]);

      expect(Exit.isFailure(invalid)).toBe(true);

      const invalidPeonGrant = yield* callersFrom([
        { ...doc, mischief: { peonCapabilities: ["unrecognizedPeonWrite"] } },
      ]);

      expect(Exit.isFailure(invalidPeonGrant)).toBe(true);
    })
);

const fleetEntry = (name: string, status?: "live" | "idle" | "retired") => {
  const did = `did:web:${name.replace("/", ".")}.pi.ratking-fleet.invalid`;

  return { did, document: documentWith(PUBLIC_JWK, did), name, status };
};

const seedText = `${JSON.stringify(
  Array.from({ length: 8 }, (_, index) => ({
    ...fleetEntry(`legacy/worker-${index}`).document,
    mischief: { mayMail: ["trusted/desk"], peonCapabilities: ["spawnPeon"] },
  })),
  null,
  4
)}\n`;

const stageCallers = Effect.fn("stageCallers")(function* stageCallers(
  names: readonly ReturnType<typeof fleetEntry>[]
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const seed = path.join(dir, "legacy.json");
  const out = path.join(dir, "generated.json");
  const directory = path.join(dir, "directory.json");
  yield* fs.writeFileString(seed, seedText);
  yield* fs.writeFileString(
    directory,
    JSON.stringify({ complete: true, names, total: names.length })
  );

  return { dir, directory, out, seed };
});

it.effect(
  "adds live and idle fleet names with self-only reach, omits retired names, and keeps all eight seed documents byte for byte",
  () =>
    Effect.gen(function* generatedCallers() {
      const fs = yield* FileSystem.FileSystem;
      const scoped = fleetEntry("new/desk", "live");
      const bare = fleetEntry("newdesk", "idle");
      const tombstone = fleetEntry("retired/desk", "retired");
      const legacy = fleetEntry("legacy/worker-0");

      const unrelated = {
        ...fleetEntry("other"),
        did: "did:web:outside.example.invalid",
      };

      const attemptedGrant = {
        ...scoped,
        document: {
          ...scoped.document,
          mischief: {
            mayMail: ["third-party/desk"],
            peonCapabilities: ["spawnPeon"],
          },
        },
      };

      const { directory, seed, out } = yield* stageCallers([
        attemptedGrant,
        bare,
        tombstone,
        legacy,
        unrelated,
      ]);

      const counts = yield* generateCallersFile(directory, seed, out);
      const generated = yield* fs.readFileString(out);
      const { callers, mailReach, peonGrants } = yield* loadCallers(out);

      expect(counts).toStrictEqual({ added: 2, legacy: 8, total: 10 });
      expect(
        generated.startsWith(seedText.slice(0, seedText.lastIndexOf("]")))
      ).toBe(true);
      expect(callers).toContain(scoped.did);
      expect(callers).toContain(bare.did);
      expect(callers).not.toContain(tombstone.did);
      expect(callers).not.toContain(unrelated.did);
      expect(callerReach(legacy.did, mailReach).names).toEqual([
        "trusted/desk",
      ]);
      expect(callerReach(scoped.did, mailReach).names).toEqual([scoped.name]);
      expect(callerReach(bare.did, mailReach).names).toEqual([bare.name]);
      expect(peonGrants).toContain(legacy.did);
      expect(peonGrants).not.toContain(scoped.did);

      const repeated = yield* Effect.exit(
        generateCallersFile(directory, seed, out)
      );

      expect(Exit.isFailure(repeated)).toBe(true);
      expect(yield* fs.readFileString(out)).toBe(generated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "refuses private JWK material in a directory entry without writing a callers file or exposing the scalar",
  () =>
    Effect.gen(function* refusedPrivate() {
      const fs = yield* FileSystem.FileSystem;
      const entry = fleetEntry("new/desk");
      const scalar = "fixture-private-scalar";

      const { directory, seed, out } = yield* stageCallers([
        {
          ...entry,
          document: documentWith({ ...PUBLIC_JWK, d: scalar }, entry.did),
        },
      ]);

      const result = yield* Effect.exit(
        generateCallersFile(directory, seed, out)
      );

      const failure = Exit.isFailure(result) ? String(result.cause) : "";

      expect(failure).toContain("private JWK fields such as d are forbidden");
      expect(failure).not.toContain(scalar);
      expect(yield* fs.exists(out)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const first = fleetEntry("sample/first", "live");

const second = fleetEntry("sample/second");

const retired = fleetEntry("sample/former");

const reservedDoc = documentWith(
  PUBLIC_JWK,
  "did:web:sample-owner.ratking-fleet.invalid"
);

const extra = fleetEntry("sample/extra");

const legacy = fleetEntry("legacy/worker-0");

const stageSnapshot = Effect.fn("stageCallerSnapshot")(
  function* stageCallerSnapshot(
    dir: string,
    names: readonly ReturnType<typeof fleetEntry>[],
    retirements: readonly { did: string; name: string }[],
    options?: {
      cursor?: string | undefined;
      missingPlacement?: string | undefined;
      incorrectTotal?: boolean;
      zeroPages?: boolean;
    }
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const digest = yield* Digest.Digest;
    const bundle = path.join(dir, "snapshot");
    const snapshot = "03ffb02c-ad0f-4a64-ab4f-062499c5da5a";

    const issuerPages = [
      {
        issuer: "issuer-a",
        names: [names.slice(0, 1)],
        retired: options?.zeroPages === true ? [] : [[]],
      },
      { issuer: "issuer-b", names: [names.slice(1)], retired: [retirements] },
    ];

    const placements = new Map<string, string>();

    for (const { issuer, names: pages } of issuerPages) {
      for (const { name } of pages.flat()) {
        if (!placements.has(name)) {
          placements.set(name, issuer);
        }
      }
    }

    if (options?.missingPlacement !== undefined) {
      placements.delete(options.missingPlacement);
    }

    const files = {
      "issuers.json": Object.fromEntries(placements),
      "names.json": {
        complete: true,
        cursor: options?.cursor,
        names,
        snapshot,
        total: names.length + Number(options?.incorrectTotal === true),
      },
      "retired.json": {
        complete: true,
        retired: retirements.map(({ did, name }) => ({
          by: first.did,
          did,
          name,
          retiredAt: "2025-01-01T00:00:00Z",
        })),
        snapshot,
        total: retirements.length,
      },
    };

    yield* fs.makeDirectory(bundle);

    const hashes = yield* Effect.forEach(
      Object.entries(files),
      ([name, body]) =>
        Effect.gen(function* snapshotFile() {
          const text = `${JSON.stringify(body)}\n`;
          yield* fs.writeFileString(path.join(bundle, name), text);

          const sha256 = yield* digest.digestHex(
            Digest.sha256,
            new TextEncoder().encode(text)
          );

          return [name, sha256] as const;
        })
    );

    yield* fs.writeFileString(
      path.join(bundle, "manifest.json"),
      JSON.stringify({
        pages: issuerPages.map(({ issuer, names: current, retired: dead }) => ({
          issuer,
          names: current.length,
          retired: dead.length,
        })),
        sha256: Object.fromEntries(hashes),
        snapshot,
        totals: { names: names.length, retired: retirements.length },
      })
    );

    return bundle;
  },
  Effect.provide(Digest.layerWebCrypto)
);

const stageSupplements = Effect.fn("stageCallerSupplements")(
  function* stageCallerSupplements(
    dir: string,
    docs: readonly ReturnType<typeof documentWith>[],
    extraEntries: readonly {
      name: string;
      document: ReturnType<typeof documentWith>;
    }[]
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reserved = path.join(dir, "reserved.json");
    const extras = path.join(dir, "extras.json");
    yield* fs.writeFileString(reserved, JSON.stringify(docs));
    yield* fs.writeFileString(extras, JSON.stringify(extraEntries));

    return { reserved, extras };
  }
);

it.effect(
  "merges verified snapshot names and both supplemental inputs, without admitting a retired caller or changing the seed",
  () =>
    Effect.gen(function* mergedCallers() {
      const fs = yield* FileSystem.FileSystem;
      const { dir, out, seed } = yield* stageCallers([]);

      const bundle = yield* stageSnapshot(
        dir,
        [first, second, legacy],
        [retired, { did: reservedDoc.id, name: "sample-owner" }],
        { zeroPages: true }
      );

      const { id, ...fields } = second.document;

      const anotherReserved = documentWith(
        PUBLIC_JWK,
        "did:web:sample-backup.ratking-fleet.invalid"
      );

      const overlappingReserved = {
        ...fields,
        id,
        mischief: { mayMail: ["sample/other"] },
      };

      const extraWithGrant = {
        ...extra,
        document: {
          ...extra.document,
          mischief: { mayMail: ["sample/other"] },
        },
      };

      const documents = yield* stageSupplements(
        dir,
        [reservedDoc, anotherReserved, overlappingReserved],
        [extraWithGrant, retired]
      );

      const counts = yield* generateCallersFile(bundle, seed, out, documents);
      expect(counts).toStrictEqual({ added: 4, legacy: 8, total: 12 });

      const generated = yield* fs.readFileString(out);
      const { callers, mailReach } = yield* loadCallers(out);

      const extension = generated.indexOf(
        `,\n${JSON.stringify(anotherReserved)}`
      );

      expect(extension).toBeGreaterThan(0);

      const restoredSeed =
        generated.slice(0, extension) +
        generated.slice(generated.lastIndexOf("]"));

      expect(restoredSeed).toBe(seedText);
      expect(callers).toContain(first.did);
      expect(callers).toContain(second.did);
      expect(callers).toContain(anotherReserved.id);
      expect(callers).not.toContain(reservedDoc.id);
      expect(callers).toContain(extra.did);
      expect(callers).not.toContain(retired.did);
      expect(callerReach(extra.did, mailReach).names).toEqual([extra.name]);
      expect(callerReach(legacy.did, mailReach).names).toEqual([
        "trusted/desk",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.each([
  ["issuers.json", /SHA-256 manifest mismatch for issuers.json/u],
  ["names.json", /SHA-256 manifest mismatch for names.json/u],
  ["retired.json", /SHA-256 manifest mismatch for retired.json/u],
  ["conflicting names", /conflicting documents/u],
  ["missing placement", /placements do not match/u],
  ["wrong total", /IDs or totals do not match/u],
  ["remaining cursor", /not a complete names list/u],
] as const)("refuses a snapshot with %s before writing", ([fault, reason]) =>
  Effect.gen(function* refusedSnapshot() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { dir, out, seed } = yield* stageCallers([]);

    const conflict = {
      ...first,
      document: { ...first.document, authentication: [] },
    };

    const bundle = yield* stageSnapshot(
      dir,
      fault === "conflicting names" ? [first, conflict] : [first, second],
      [],
      {
        cursor: fault === "remaining cursor" ? "next-page" : undefined,
        missingPlacement:
          fault === "missing placement" ? second.name : undefined,
        incorrectTotal: fault === "wrong total",
      }
    );

    if (fault.endsWith(".json")) {
      yield* fs.writeFileString(path.join(bundle, fault), "{}\n");
    }

    const error = yield* Effect.flip(generateCallersFile(bundle, seed, out));
    expect(String(error)).toMatch(reason);
    expect(yield* fs.exists(out)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.each([
  ["conflicting documents", /conflicting documents/u],
  ["conflicting reserved document", /conflicting documents/u],
  [
    "invalid reserved name",
    /must name a bare reserved fleet caller or match the fleet name template/u,
  ],
  ["mismatched extra name", /Extra DID does not match fleet name/u],
  ["private reserved key", /private JWK fields such as d are forbidden/u],
  ["duplicate DID", /repeats the fleet DID/u],
] as const)(
  "refuses supplemental inputs with %s before writing",
  ([fault, reason]) =>
    Effect.gen(function* refusedSupplements() {
      const fs = yield* FileSystem.FileSystem;
      const { dir, directory, out, seed } = yield* stageCallers([first]);

      const reserved = {
        "conflicting documents": [reservedDoc],
        "conflicting reserved document": [
          { ...first.document, authentication: [] },
        ],
        "duplicate DID": [reservedDoc],
        "invalid reserved name": [
          documentWith(
            PUBLIC_JWK,
            "did:web:bad.project.row.pi.ratking-fleet.invalid"
          ),
        ],
        "mismatched extra name": [reservedDoc],
        "private reserved key": [
          documentWith(
            { ...PUBLIC_JWK, d: "synthetic-private-value" },
            reservedDoc.id
          ),
        ],
      }[fault];

      const extras = {
        "conflicting documents": [
          { ...first, document: { ...first.document, authentication: [] } },
        ],
        "conflicting reserved document": [],
        "duplicate DID": [extra, extra],
        "invalid reserved name": [],
        "mismatched extra name": [{ ...extra, name: "sample/mismatch" }],
        "private reserved key": [],
      }[fault];

      const documents = yield* stageSupplements(dir, reserved, extras);

      const error = yield* Effect.flip(
        generateCallersFile(directory, seed, out, documents)
      );

      expect(String(error)).toMatch(reason);
      expect(String(error)).not.toContain("synthetic-private-value");
      expect(yield* fs.exists(out)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.each([
  ["wrong directory total", /total does not match/u],
  ["wrong directory name", /Directory DID does not match fleet name/u],
  ["wrong document ID", /Caller document ID does not match fleet name/u],
  ["repeated seed DID", /Legacy seed repeats a DID/u],
] as const)("refuses %s without publishing", ([fault, reason]) =>
  Effect.gen(function* refusedInput() {
    const fs = yield* FileSystem.FileSystem;

    const entries = {
      "wrong directory total": [],
      "wrong directory name": [{ ...first, name: second.name }],
      "wrong document ID": [{ ...first, document: second.document }],
      "repeated seed DID": [],
    }[fault];

    const { directory, out, seed } = yield* stageCallers(entries);

    if (fault === "wrong directory total") {
      yield* fs.writeFileString(
        directory,
        JSON.stringify({ complete: true, names: [], total: 1 })
      );
    }

    if (fault === "repeated seed DID") {
      yield* fs.writeFileString(
        seed,
        JSON.stringify([legacy.document, legacy.document])
      );
    }

    const error = yield* Effect.flip(generateCallersFile(directory, seed, out));
    expect(String(error)).toMatch(reason);
    expect(yield* fs.exists(out)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const cli = fileURLToPath(
  new URL("../generate-callers-cli.ts", import.meta.url)
);

const jiti = fileURLToPath(
  new URL("../node_modules/jiti/lib/jiti-cli.mjs", import.meta.url)
);

const runGenerator = Effect.fn("runCallerGeneratorCli")(function* runGenerator(
  args: readonly string[]
) {
  const child = yield* ChildProcess.make(
    process.execPath,
    [jiti, cli, ...args],
    { stderr: "pipe", stdout: "pipe" }
  );

  return yield* Effect.all(
    {
      code: child.exitCode,
      stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    },
    { concurrency: "unbounded" }
  );
});

it.effect(
  "the snapshot CLI merges identical issuer entries, warns for a retired DID, and admits only the new binding",
  () =>
    Effect.gen(function* retirementAndMerge() {
      const rebound = fleetEntry("sample-owner");
      const markedRetired = fleetEntry("sample/marked", "retired");
      const { dir, out, seed } = yield* stageCallers([]);

      const bundle = yield* stageSnapshot(
        dir,
        [first, first, second, markedRetired, rebound],
        [first, { did: reservedDoc.id, name: rebound.name }]
      );

      const otherDuplicate = fleetEntry("sample/aa_a");
      const sortsFirst = fleetEntry("sample/aa-a");

      const mergedDir = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped()
      );

      const mergeBundle = yield* stageSnapshot(
        mergedDir,
        [otherDuplicate, otherDuplicate, sortsFirst],
        []
      );

      const mergeOut = `${out}.merged`;

      const duplicateCounts = yield* generateCallersFile(
        mergeBundle,
        seed,
        mergeOut
      );

      expect(duplicateCounts).toStrictEqual({ added: 2, legacy: 8, total: 10 });
      const merged = yield* loadCallers(mergeOut);
      expect(merged.callers.indexOf(sortsFirst.did)).toBeLessThan(
        merged.callers.indexOf(otherDuplicate.did)
      );

      const docs = yield* stageSupplements(dir, [reservedDoc], [markedRetired]);

      const result = yield* runGenerator([
        bundle,
        seed,
        out,
        docs.reserved,
        docs.extras,
      ]);

      expect(Number(result.code)).toBe(0);
      expect(result.stdout.trim()).toBe('{"added":2,"legacy":8,"total":10}');
      expect(result.stderr).toContain(`Skipping retired DID for ${first.name}`);
      expect(result.stderr).toContain(
        `Skipping retired DID for ${markedRetired.name}`
      );
      expect(result.stderr).toContain(
        `Skipping retired DID for ${rebound.name}`
      );
      const { callers } = yield* loadCallers(out);
      expect(callers).toContain(rebound.did);
      expect(callers).toContain(second.did);
      expect(callers).not.toContain(first.did);
      expect(callers).not.toContain(markedRetired.did);
      expect(callers).not.toContain(reservedDoc.id);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "the CLI accepts the legacy three arguments but refuses four without writing",
  () =>
    Effect.gen(function* cliArguments() {
      const fs = yield* FileSystem.FileSystem;
      const { dir, directory, out, seed } = yield* stageCallers([]);
      const docs = yield* stageSupplements(dir, [reservedDoc], []);

      const incomplete = yield* runGenerator([
        directory,
        seed,
        out,
        docs.reserved,
      ]);

      expect(Number(incomplete.code)).toBe(1);
      expect(incomplete.stdout + incomplete.stderr).toContain(
        "Use pnpm --filter @mischief/infra generate-callers"
      );
      expect(yield* fs.exists(out)).toBe(false);

      const original = yield* runGenerator([directory, seed, out]);
      expect(Number(original.code)).toBe(0);
      expect(original.stdout.trim()).toBe('{"added":0,"legacy":8,"total":8}');
      expect(yield* fs.readFileString(out)).toBe(seedText);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
