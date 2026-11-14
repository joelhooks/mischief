import { parsePhaseOneCallerConfig } from "@mischief/client";
import { Config, Effect, FileSystem, Schema } from "effect";

const MischiefDid = Schema.String.check(
  Schema.isPattern(/^did:web:[a-z0-9.-]+$/u)
);

const Keys = Schema.Struct({
  id: Schema.String,
  verificationMethod: Schema.Array(
    Schema.Struct({
      publicKeyJwk: Schema.Record(Schema.String, Schema.Unknown),
    })
  ),
});

export const callersFromConfig = Effect.gen(function* callersFromConfig() {
  const fs = yield* FileSystem.FileSystem;

  const did = yield* Config.schema(MischiefDid, "MISCHIEF_DID");

  const text = yield* fs.readFileString(
    yield* Config.String("MISCHIEF_CALLERS_FILE")
  );

  const keys = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(Keys))
  )(text).pipe(Effect.orElseSucceed(() => []));

  const holder = keys.find(({ verificationMethod }) =>
    verificationMethod.some(({ publicKeyJwk }) => "d" in publicKeyJwk)
  );

  if (holder !== undefined) {
    return yield* Effect.die(
      new Error(
        `MISCHIEF_CALLERS_FILE holds a private key for ${holder.id}. Mischief only verifies, so it takes public DID documents: remove "d" from every publicKeyJwk, then rotate that key, since it has been copied`
      )
    );
  }

  const callers = yield* Effect.try(() => parsePhaseOneCallerConfig(text)).pipe(
    Effect.orDie
  );

  return { ...callers, did };
});
