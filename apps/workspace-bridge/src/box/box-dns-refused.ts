import { Effect, Schema } from "effect";

import { BROWSER_BOX_GATEWAY, BROWSER_BOX_NETWORK } from "./live-owner.js";
import type { BoxNetwork } from "./live-owner.js";

export class BoxDnsRefused extends Schema.TaggedError<
  BoxDnsRefused,
  { readonly brand: unique symbol }
>()("BoxDnsRefused", {
  message: Schema.String,
  status: Schema.Literal(503),
}) {}

export const checkBoxCreateDns = (
  network: BoxNetwork,
  args: readonly string[]
) => {
  if (network !== BROWSER_BOX_NETWORK) {
    return Effect.void;
  }

  const dns = args.indexOf("--dns");

  return dns !== -1 &&
    args[dns + 1] === BROWSER_BOX_GATEWAY &&
    args.lastIndexOf("--dns") === dns &&
    !args.some((arg) => arg.startsWith("--dns="))
    ? Effect.void
    : Effect.fail(
        new BoxDnsRefused({
          message: `Browser Docker create requires exactly one --dns ${BROWSER_BOX_GATEWAY}. Fix the manager's browser launch arguments, then retry the same request.`,
          status: 503,
        })
      );
};
