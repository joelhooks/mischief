import { AgentName } from "@rat-king/mailbox-client";
import { Option, Schema } from "effect";

export const FLEET_TEMPLATE = "did:web:{agent}.pi.ratking-fleet.invalid";

interface Reserved {
  readonly aliases?: readonly string[];
  readonly did: string;
}

export const RESERVED = {
  "claude-bridge-owner": {
    did: "did:web:claude-bridge-owner.muster.ratking-fleet.invalid",
  },
  "cliproxy-owner": {
    did: "did:web:cliproxy-owner.muster.ratking-fleet.invalid",
  },
  "joel-iphone": {
    aliases: ["joel-phone"],
    did: "did:web:joel-iphone.ratking-fleet.invalid",
  },
  operator: {
    aliases: ["ship"],
    did: "did:web:operator.ratking-fleet.invalid",
  },
  "pennywise-owner": {
    aliases: ["servo"],
    did: "did:web:pennywise-owner.ratking-fleet.invalid",
  },
  "rubicon-fitness-owner": {
    aliases: ["titan"],
    did: "did:web:rubicon-fitness-owner.muster.ratking-fleet.invalid",
  },
  switchboard: {
    aliases: ["ernestine"],
    did: "did:web:switchboard.ratking-fleet.invalid",
  },
} as const satisfies Readonly<Record<string, Reserved>>;

const reserved: readonly (readonly [string, Reserved])[] =
  Object.entries(RESERVED);

const isName = Schema.is(AgentName);

export const canonicalName = (name: string) =>
  reserved.find(([, entry]) => entry.aliases?.includes(name) === true)?.[0] ??
  name;

export const didFor = (name: string): Option.Option<string> => {
  if (!isName(name)) {
    return Option.none();
  }

  return Option.some(
    reserved.find(([key]) => key === canonicalName(name))?.[1].did ??
      FLEET_TEMPLATE.replace("{agent}", name.replace("/", "."))
  );
};

export const nameFor = (did: string): Option.Option<string> => {
  const fixed = reserved.find(([, entry]) => entry.did === did);

  if (fixed !== undefined) {
    return Option.some(fixed[0]);
  }

  const [prefix = "", suffix = ""] = FLEET_TEMPLATE.split("{agent}");

  if (
    !did.startsWith(prefix) ||
    !did.endsWith(suffix) ||
    did.length <= prefix.length + suffix.length
  ) {
    return Option.none();
  }

  const name = did
    .slice(prefix.length, did.length - suffix.length)
    .replace(".", "/");

  return Option.filter(Option.some(name), (candidate) =>
    Option.contains(didFor(candidate), did)
  );
};
