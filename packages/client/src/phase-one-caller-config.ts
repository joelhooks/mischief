import {
  callerReach,
  MailReachSchema,
  peonCapabilityNames,
} from "@mischief/core";
import { Documents } from "@rat-king/mailbox-client/auth";
import { Schema } from "effect";

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

const parseCallerConfig = (text: string) => {
  const callers = Schema.decodeUnknownSync(Schema.fromJsonString(Documents))(
    text
  );

  if (callers.length === 0) {
    throw new Error(
      "MISCHIEF_CALLERS_FILE lists no callers, so the host would serve nobody. Add the shadow driver's DID document"
    );
  }

  const grants = Schema.decodeUnknownSync(Grants)(text);

  const mailReach = JSON.stringify(
    Object.fromEntries(
      grants.flatMap(({ id, mischief }) =>
        mischief?.mayMail === undefined ? [] : [[id, mischief.mayMail]]
      )
    )
  );

  Schema.decodeUnknownSync(Schema.fromJsonString(MailReachSchema))(mailReach);

  for (const { id } of callers) {
    const reach = callerReach(id, mailReach);

    if (reach.reason !== undefined) {
      throw new Error(reach.reason);
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
};

export const parsePhaseOneCallerConfig = (text: string) => {
  try {
    return parseCallerConfig(text);
  } catch (error) {
    throw new Error(
      `MISCHIEF_CALLERS_FILE is invalid: ${String(error)}. Correct the named field in the public caller documents, then retry the plan.`,
      { cause: error }
    );
  }
};
