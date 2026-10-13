import { runCapabilities, scheduleCapabilities } from "@mischief/core";
// @effect-diagnostics asyncFunction:off -- a Durable Object stub's RPC methods are Promise APIs.
import {
  ReplayAuthority,
  ServiceAuthFailure,
} from "@rat-king/mailbox-client/auth";
import { Effect, Layer } from "effect";

import { NSID_PREFIX } from "./service-auth.js";

export interface Ledger {
  readonly consume: (
    jti: string,
    exp: number,
    nowSeconds: number,
    durable: boolean
  ) => Promise<boolean>;
}

export const READ_ONLY: ReadonlySet<string> = new Set(
  [
    ...[...runCapabilities, ...scheduleCapabilities].flatMap(({ contract }) =>
      contract.annotations.readOnly ? [contract.name] : []
    ),
    "openApi",
  ].map((name) => `${NSID_PREFIX}${name}`)
);

export const replayLedger = (
  ledgerFor: (issuer: string) => Ledger,
  readOnly: ReadonlySet<string>
) =>
  Layer.succeed(
    ReplayAuthority,
    ReplayAuthority.of({
      consume: (claims, now) =>
        Effect.tryPromise({
          catch: () =>
            new ServiceAuthFailure({
              error: "ReplayUnavailable",
              message:
                "the host could not record this token's jti, so it refuses it. Send a fresh token again shortly",
              response: {},
              status: 503,
            }),
          try: async () =>
            await ledgerFor(claims.iss).consume(
              claims.jti,
              claims.exp,
              Math.floor(now / 1000),
              !readOnly.has(claims.lxm)
            ),
        }).pipe(
          Effect.flatMap((fresh) =>
            fresh
              ? Effect.void
              : Effect.fail(
                  new ServiceAuthFailure({
                    error: "AuthRequired",
                    message: `this token (jti ${claims.jti}) was already used. Every request needs a fresh jti`,
                    response: {},
                    status: 401,
                  })
                )
          )
        ),
    })
  );
