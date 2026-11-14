import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, FileSystem, Path } from "effect";

import { callersFromConfig } from "../callers.ts";

const PUBLIC_JWK = {
  crv: "P-256",
  kty: "EC",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
};

const documentWith = (publicKeyJwk: Record<string, string>) => ({
  authentication: [
    "did:web:agent-graph.driver.pi.ratking-fleet.invalid#atproto",
  ],
  id: "did:web:agent-graph.driver.pi.ratking-fleet.invalid",
  keyAgreement: [],
  verificationMethod: [
    {
      controller: "did:web:agent-graph.driver.pi.ratking-fleet.invalid",
      id: "did:web:agent-graph.driver.pi.ratking-fleet.invalid#atproto",
      publicKeyJwk,
    },
  ],
});

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

    return yield* Effect.exit(
      callersFromConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              MISCHIEF_CALLERS_FILE: file,
              MISCHIEF_DID: "did:web:mischief.example.invalid",
            })
          )
        )
      )
    );
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

      const granted = yield* callersFrom([
        {
          ...doc,
          mischief: {
            mayMail: ["other/desk"],
            peonCapabilities: ["spawnPeon", "promptPeon"],
          },
        },
      ]);

      expect(Exit.isSuccess(granted)).toBe(true);

      if (Exit.isSuccess(granted)) {
        expect(JSON.parse(granted.value.mailReach)).toStrictEqual({
          [doc.id]: ["other/desk"],
        });
        expect(granted.value.callers).toBe(JSON.stringify([doc]));
        expect(JSON.parse(granted.value.peonGrants)).toStrictEqual({
          [doc.id]: ["spawnPeon", "promptPeon"],
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
