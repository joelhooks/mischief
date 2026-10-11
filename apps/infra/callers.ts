import { Documents } from "@rat-king/mailbox-client";
import { Config, Effect, FileSystem, Schema } from "effect";

const MischiefDid = Schema.String.check(
  Schema.isPattern(/^did:web:[a-z0-9.-]+$/u)
);

export const callersFromConfig = Effect.gen(function* callersFromConfig() {
  const fs = yield* FileSystem.FileSystem;

  const did = yield* Config.schema(MischiefDid, "MISCHIEF_DID");

  const text = yield* fs.readFileString(
    yield* Config.String("MISCHIEF_CALLERS_FILE")
  );

  const callers = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Documents)
  )(text).pipe(
    Effect.catchCause(() =>
      Effect.die(
        new Error(
          "MISCHIEF_CALLERS_FILE must hold a JSON array of Rat King DID documents (id, authentication, keyAgreement, verificationMethod with a P-256 publicKeyJwk), one per caller allowed to drive runs"
        )
      )
    )
  );

  if (callers.length === 0) {
    return yield* Effect.die(
      new Error(
        "MISCHIEF_CALLERS_FILE lists no callers, so the host would serve nobody. Add the shadow driver's DID document"
      )
    );
  }

  return { callers: JSON.stringify(callers), did };
});
