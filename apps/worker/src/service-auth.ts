import { authenticateClaims } from "@rat-king/mailbox-client/auth";
import { Clock, Effect } from "effect";

import { AuthRefused } from "./auth-refused.js";

export { AuthRefused } from "./auth-refused.js";

export const NSID_PREFIX = "sh.mschf.mischief.";

const SKEW_SECONDS = 5;

const MINT = `Mint a fresh Rat King service token with serviceToken from @rat-king/mailbox-client/auth (ES256, signed with your DID's #atproto key): iss your DID, aud the host's audience, lxm ${NSID_PREFIX}<capability>, a unique jti of at least 16 characters, iat now and exp at most 60 seconds later. Send it as Authorization: Bearer <token>. A caller missing from the host's allowlist asks the Mischief desk (pi-durable/desk) to add its DID document`;

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
      Effect.catchTag("XrpcFailure", (failure) =>
        Effect.fail(
          new AuthRefused({
            reason: `${failure.message ?? failure.error} (this request calls ${request.lxm} on ${request.audience}). ${MINT}`,
          })
        )
      )
    );

    return claims;
  }
);
