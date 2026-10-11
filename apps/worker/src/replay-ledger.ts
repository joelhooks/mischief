// @effect-diagnostics asyncFunction:off -- a Durable Object stub's RPC methods are Promise APIs.
import {
  ReplayAuthority,
  ServiceAuthFailure,
} from "@rat-king/mailbox-client/auth";
import { Effect, Layer } from "effect";

export interface Ledger {
  readonly consume: (
    jti: string,
    exp: number,
    nowSeconds: number
  ) => Promise<boolean>;
}

export const replayLedger = (ledgerFor: (issuer: string) => Ledger) =>
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
              Math.floor(now / 1000)
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
