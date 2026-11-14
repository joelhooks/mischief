import {
  callerReach,
  MailReachSchema,
  peonCapabilityNames,
} from "@mischief/core";
import { Documents } from "@rat-king/mailbox-client/auth";
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

const Grants = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      mischief: Schema.optionalKey(
        Schema.Struct({
          mayMail: Schema.optionalKey(Schema.Array(Schema.String)),
          peonCapabilities: Schema.optionalKey(
            Schema.Array(
              Schema.String.check(
                Schema.makeFilter((name) => peonCapabilityNames.has(name), {
                  message:
                    "mischief.peonCapabilities must name supported Peon capabilities; use spawnPeon, promptPeon, suspendPeon, resumePeon, hibernatePeon, clonePeon, destroyPeon, inspectPeon, listPeonTemplates, savePeonTemplate or listPeons",
                })
              )
            )
          ),
        })
      ),
    })
  )
);

const callerConfig = Effect.fn("callerConfig")(
  function* decodeCallerConfig(text: string) {
    const callers = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Documents)
    )(text);

    if (callers.length === 0) {
      return yield* Effect.die(
        new Error(
          "MISCHIEF_CALLERS_FILE lists no callers, so the host would serve nobody. Add the shadow driver's DID document"
        )
      );
    }

    const grants = yield* Schema.decodeUnknownEffect(Grants)(text);

    const mailReach = JSON.stringify(
      Object.fromEntries(
        grants.flatMap(({ id, mischief }) =>
          mischief?.mayMail === undefined ? [] : [[id, mischief.mayMail]]
        )
      )
    );

    yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MailReachSchema))(
      mailReach
    );

    for (const { id } of callers) {
      const reach = callerReach(id, mailReach);

      if (reach.reason !== undefined) {
        return yield* Effect.die(new Error(reach.reason));
      }
    }

    const peonGrants = JSON.stringify(
      Object.fromEntries(
        grants.flatMap(({ id, mischief }) =>
          mischief?.peonCapabilities === undefined
            ? []
            : [[id, mischief.peonCapabilities]]
        )
      )
    );

    return { callers: JSON.stringify(callers), mailReach, peonGrants };
  },
  Effect.mapError(
    (failure) =>
      new Error(
        `MISCHIEF_CALLERS_FILE is invalid: ${String(failure)}. Correct the named field in the public caller documents, then retry the plan.`,
        { cause: failure }
      )
  ),
  Effect.orDie
);

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

  const callers = yield* callerConfig(text);

  return { ...callers, did };
});
