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
  authentication: ["did:web:driver.example.invalid#atproto"],
  id: "did:web:driver.example.invalid",
  keyAgreement: [],
  verificationMethod: [
    {
      controller: "did:web:driver.example.invalid",
      id: "did:web:driver.example.invalid#atproto",
      publicKeyJwk,
    },
  ],
});

const callersFrom = (documents: readonly ReturnType<typeof documentWith>[]) =>
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
        /private key for did:web:driver\.example\.invalid.*rotate/u
      );

      const clean = yield* callersFrom([documentWith(PUBLIC_JWK)]);

      expect(Exit.isSuccess(clean) ? clean.value.callers : "").toBe(
        JSON.stringify([documentWith(PUBLIC_JWK)])
      );
    })
);
