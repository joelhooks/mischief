import { Schema } from "effect";

import { BOX_NETWORK, BROWSER_BOX_NETWORK } from "./live-owner.js";

export class BoxNetworkUnavailable extends Schema.TaggedError<
  BoxNetworkUnavailable,
  { readonly brand: unique symbol }
>()("BoxNetworkUnavailable", {
  message: Schema.String,
  network: Schema.Literals([BOX_NETWORK, BROWSER_BOX_NETWORK]),
  status: Schema.Literal(503),
}) {}
