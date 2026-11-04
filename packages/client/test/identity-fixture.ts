import { Identity, PrivateJwk } from "@rat-king/mailbox-client";
import { Effect, Schema } from "effect";

const generateKey: (
  algorithm: EcKeyGenParams,
  extractable: boolean,
  usages: KeyUsage[]
) => Promise<CryptoKeyPair> = crypto.subtle.generateKey.bind(crypto.subtle);

const exportKey: (format: "jwk", key: CryptoKey) => Promise<JsonWebKey> =
  crypto.subtle.exportKey.bind(crypto.subtle);

export const freshIdentity = Effect.fn("test.freshIdentity")(
  function* freshIdentity(did?: string) {
    const pair = yield* Effect.promise(
      generateKey.bind(
        undefined,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"]
      )
    );

    if (!("privateKey" in pair)) {
      return yield* Effect.die("ECDSA did not return a key pair");
    }

    const signing = yield* Effect.promise(
      exportKey.bind(undefined, "jwk", pair.privateKey)
    );

    const key = yield* Schema.decodeUnknownEffect(PrivateJwk)(signing);

    return yield* Schema.decodeUnknownEffect(Identity)({
      agreement: key,
      did: did ?? "did:web:caller.example.invalid",
      signing: key,
    });
  }
);
