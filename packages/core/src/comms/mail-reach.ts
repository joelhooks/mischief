import { Option, Schema } from "effect";

import { stepsOf } from "../plans/doc-refs.js";
import { EnvelopeSchema, PlanMachine, RatKingName } from "../plans/schema.js";

export const SHADOW_PREFIX = "shadow/";

export const MailReachSchema = Schema.Record(
  Schema.String,
  Schema.Array(RatKingName)
);

export const callerName = (did: string) => {
  const scoped =
    /^did:web:(?<project>[a-z0-9-]+)\.(?<desk>[a-z0-9_-]+)\.pi\.ratking-fleet\.invalid$/u.exec(
      did
    );

  const bare = /^did:web:(?<name>[a-z0-9_-]+)\.ratking-fleet\.invalid$/u.exec(
    did
  );

  const name =
    scoped === null
      ? bare?.groups?.name
      : `${scoped.groups?.project}/${scoped.groups?.desk}`;

  return Option.flatMap(
    Option.fromNullishOr(name),
    Schema.decodeUnknownOption(RatKingName)
  );
};

export const callerReach = (did: string, config?: string) => {
  const own = callerName(did);

  if (Option.isNone(own)) {
    return {
      names: [],
      reason: `cannot derive a Rat King name from caller ${did}. Use did:web:<project>.<desk>.pi.ratking-fleet.invalid or did:web:<name>.ratking-fleet.invalid; ask the Mischief desk (pi-durable/desk) to correct the caller DID`,
    };
  }

  const map = Schema.decodeOption(Schema.fromJsonString(MailReachSchema))(
    config ?? "{}"
  );

  if (Option.isNone(map)) {
    return {
      names: [],
      reason:
        "MISCHIEF_MAIL_REACH is not a JSON map of caller DIDs to Rat King name arrays. Ask the Mischief desk (pi-durable/desk) to correct the host config",
    };
  }

  return { names: map.value[did] ?? [own.value], reason: undefined };
};

export const mailReachReason = (
  did: string,
  key: string,
  to: string,
  config?: string
) => {
  const reach = callerReach(did, config);

  return (
    reach.reason ??
    (to.startsWith(SHADOW_PREFIX) || reach.names.includes(to)
      ? undefined
      : `step ${key}: Rat King name "${to}" is outside caller ${did}'s mail reach. Allowed: ${reach.names.join(", ") || "none"}. Ask the Mischief desk (pi-durable/desk) to add "${to}" to this caller's mischief.mayMail`)
  );
};

const Escalation = Schema.fromJsonString(
  Schema.Struct({ escalateTo: Schema.optionalKey(RatKingName) })
);

export const escalationMailReachReason = (
  did: string,
  body: string,
  config?: string
) =>
  Option.getOrUndefined(
    Option.map(Schema.decodeOption(Escalation)(body), ({ escalateTo }) =>
      escalateTo === undefined
        ? callerReach(did, config).reason
        : mailReachReason(did, "escalateTo", escalateTo, config)
    )
  );

const Submission = Schema.fromJsonString(
  Schema.Struct({
    plan: Schema.Struct({ envelope: EnvelopeSchema, machine: PlanMachine }),
  })
);

export const submitMailReachReason = (
  did: string,
  body: string,
  config?: string
) =>
  escalationMailReachReason(did, body, config) ??
  Option.getOrUndefined(
    Option.map(Schema.decodeOption(Submission)(body), ({ plan }) => {
      const steps = stepsOf(plan.machine.states);

      return (
        callerReach(did, config).reason ??
        plan.envelope.names
          .map((to, index) => {
            const step = steps.find(
              ({ step: candidate }) =>
                candidate.kind === "ask" && candidate.to === to
            );

            return mailReachReason(
              did,
              step?.where ?? `envelope.names[${index}]`,
              to,
              config
            );
          })
          .find((reason) => reason !== undefined)
      );
    })
  );
