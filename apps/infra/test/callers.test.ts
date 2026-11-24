import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { callerReach } from "@mischief/core";
import { ConfigProvider, Effect, Exit, FileSystem, Path } from "effect";

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

  return { directory, out, seed };
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
