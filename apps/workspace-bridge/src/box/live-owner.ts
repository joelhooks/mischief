import { isIPv4 } from "node:net";

import { Effect, Schema } from "effect";

import { refusal } from "../protocol.js";
import { PeonId } from "./protocol.js";

export const BOX_NETWORK = "mischief-peon-boxes";

export const BROWSER_BOX_NETWORK = "mischief-peon-browser";

export const BROWSER_BOX_GATEWAY = "172.30.213.1";

export type BoxNetwork = typeof BOX_NETWORK | typeof BROWSER_BOX_NETWORK;

const PREFIX = "mischief-peon-box-";

export const containerOf = (id: string) => `${PREFIX}${id}`;

const Inventory = Schema.fromJsonString(
  Schema.NullOr(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        IPv4Address: Schema.String,
        Name: Schema.String,
      })
    )
  )
);

export const ipv4Peer = (peer: string) => peer.replace(/^::ffff:/iu, "");

export const boxNetworkForPeer = (peer: string): BoxNetwork | undefined => {
  const address = ipv4Peer(peer);

  if (!isIPv4(address)) {
    return undefined;
  }

  if (address.startsWith("172.30.211.") && address !== "172.30.211.1") {
    return BOX_NETWORK;
  }

  if (address.startsWith("172.30.213.") && address !== BROWSER_BOX_GATEWAY) {
    return BROWSER_BOX_NETWORK;
  }

  return undefined;
};

export const liveBoxInventory = Effect.fnUntraced(function* liveBoxInventory(
  output: string
) {
  const inventory = yield* Schema.decodeEffect(Inventory)(output.trim()).pipe(
    Effect.mapError(() =>
      refusal(
        "Docker returned an unreadable box network inventory. Inspect the manager's Docker network and retry.",
        503
      )
    )
  );

  const entries = new Map<
    string,
    { readonly containerId: string; readonly peonId: string } | undefined
  >();

  for (const [containerId, { IPv4Address, Name }] of Object.entries(
    inventory ?? {}
  )) {
    const [peer] = IPv4Address.split("/");

    if (peer === undefined || peer === "") {
      continue;
    }

    const peonId = Name.startsWith(PREFIX)
      ? Name.slice(PREFIX.length)
      : undefined;

    entries.set(
      peer,
      !entries.has(peer) && Schema.is(PeonId)(peonId)
        ? { containerId, peonId }
        : undefined
    );
  }

  return entries;
});

export const liveBoxId = (output: string, peer: string) =>
  liveBoxInventory(output).pipe(
    Effect.map((entries) => entries.get(ipv4Peer(peer))?.peonId)
  );

export const changesBoxNetwork = (args: readonly string[]) =>
  ["create", "start", "stop", "rm"].some(
    (operation) => operation === args[0]
  ) && args.some((arg) => arg.startsWith(PREFIX));
