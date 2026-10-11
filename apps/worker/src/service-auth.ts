import {
  authenticateClaims,
  ReplayAuthority,
} from "@rat-king/mailbox-client/auth";
import type { ClaimsValue } from "@rat-king/mailbox-client/auth";
import { Clock, Context, Effect, Layer } from "effect";

import { AuthRefused } from "./auth-refused.js";

export { AuthRefused } from "./auth-refused.js";

export const NSID_PREFIX = "sh.mschf.mischief.";

const SKEW_SECONDS = 5;

export class ServiceTokens extends Context.Service<
  ServiceTokens,
  {
    readonly consume: (
      claims: ClaimsValue,
      now: number
    ) => Effect.Effect<boolean, AuthRefused>;
  }
>()("mischief/ServiceTokens") {}

const MINT = `Mint a fresh Rat King service token with serviceToken from @rat-king/mailbox-client/auth (ES256, signed with your DID's #atproto key): iss your DID, aud the host's audience, lxm ${NSID_PREFIX}<capability>, a unique jti of at least 16 characters, iat now and exp at most 60 seconds later. Send it as Authorization: Bearer <token>. A caller missing from the host's allowlist asks the Mischief desk (pi-durable/desk) to add its DID document`;

const replayAfterVerify = Layer.succeed(
  ReplayAuthority,
  ReplayAuthority.of({ consume: () => Effect.void })
);

export interface AuthRequest {
  readonly audience: string;
  readonly authorization: string | null;
  readonly lxm: string;
}

export const authenticate = Effect.fn("Mischief.authenticate")(
  function* authenticate(request: AuthRequest) {
    const now = yield* Clock.currentTimeMillis;

    const claims = yield* authenticateClaims({
      audience: request.audience,
      authorization: request.authorization,
      now,
      nsid: request.lxm,
      skewSeconds: SKEW_SECONDS,
    }).pipe(
      Effect.provide(replayAfterVerify),
      Effect.catchTag("XrpcFailure", (failure) =>
        Effect.fail(
          new AuthRefused({
            reason: `${failure.message ?? failure.error} (this request calls ${request.lxm} on ${request.audience}). ${MINT}`,
          })
        )
      )
    );

    const tokens = yield* ServiceTokens;

    if (!(yield* tokens.consume(claims, Math.floor(now / 1000)))) {
      return yield* new AuthRefused({
        reason: `this token (jti ${claims.jti}) was already used. Every request needs a fresh jti. ${MINT}`,
      });
    }

    return claims;
  }
);
