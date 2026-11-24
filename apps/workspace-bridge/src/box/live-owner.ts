import { Effect, Schema } from "effect";

import { refusal } from "../protocol.js";
import { PeonId } from "./protocol.js";

export const BOX_NETWORK = "mischief-peon-boxes";

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

export const liveBoxId = Effect.fnUntraced(function* liveBoxId(
  output: string,
  peer: string
) {
  const inventory = yield* Schema.decodeEffect(Inventory)(output.trim()).pipe(
    Effect.mapError(() =>
      refusal(
        "Docker returned an unreadable box network inventory. Inspect the manager's Docker network and retry.",
        503
      )
    )
  );

  const address = ipv4Peer(peer);

  const matches = Object.values(inventory ?? {}).filter(
    ({ IPv4Address }) =>
      IPv4Address !== "" && IPv4Address.split("/")[0] === address
  );

  const found = matches.length === 1 ? matches[0]?.Name : undefined;

  const id =
    found !== undefined && found.startsWith(PREFIX)
      ? found.slice(PREFIX.length)
      : undefined;

  return Schema.is(PeonId)(id) ? id : undefined;
});
