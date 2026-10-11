// @effect-diagnostics asyncFunction:off -- WebCrypto's verify is a Promise API.
import { Claims, DidResolver, unbase64url } from "@rat-king/mailbox-client";
import type { ClaimsValue } from "@rat-king/mailbox-client";
import { Clock, Context, Effect, Schema } from "effect";

import { AuthRefused } from "./auth-refused.js";

export { AuthRefused } from "./auth-refused.js";

export const NSID_PREFIX = "sh.mschf.mischief.";

const P256_ORDER =
  0xff_ff_ff_ff_00_00_00_00_ff_ff_ff_ff_ff_ff_ff_ff_bc_e6_fa_ad_a7_17_9e_84_f3_b9_ca_c2_fc_63_25_51n;

const WINDOW_SECONDS = 60;

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

const Header = Schema.Struct({
  alg: Schema.Literal("ES256"),
  kid: Schema.optionalKey(Schema.String),
  typ: Schema.optionalKey(Schema.Literal("JWT")),
});

const refuse = (reason: string) => Effect.fail(new AuthRefused({ reason }));

const MINT = `Mint a fresh Rat King service token (ES256, signed with your DID's #atproto key) with iss your DID, aud the host's audience, lxm ${NSID_PREFIX}<capability>, a unique jti of at least 16 characters, iat now and exp at most ${WINDOW_SECONDS} seconds later, and send it as Authorization: Bearer <token>`;

const decodePart = <A, I>(schema: Schema.Codec<A, I>, text: string) =>
  Effect.try({
    catch: () => new AuthRefused({ reason: `the token is not a JWT. ${MINT}` }),
    try: () => new TextDecoder().decode(unbase64url(text)),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
    Effect.mapError(
      () =>
        new AuthRefused({
          reason: `the token's header or claims do not match Rat King service auth. ${MINT}`,
        })
    )
  );

const scalar = (bytes: Uint8Array) =>
  BigInt(
    `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  );

const lowS = (signature: Uint8Array) =>
  signature.length === 64 &&
  scalar(signature.subarray(0, 32)) > 0n &&
  scalar(signature.subarray(0, 32)) < P256_ORDER &&
  scalar(signature.subarray(32)) > 0n &&
  scalar(signature.subarray(32)) <= P256_ORDER / 2n;

export interface AuthRequest {
  readonly audience: string;
  readonly authorization: string | null;
  readonly lxm: string;
}

export const authenticate = Effect.fn("Mischief.authenticate")(
  function* authenticate(request: AuthRequest) {
    const token = request.authorization?.match(
      /^Bearer (?<token>[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u
    )?.groups?.token;

    if (token === undefined) {
      return yield* refuse(`this request carries no service token. ${MINT}`);
    }

    const [headerText = "", claimsText = "", signatureText = ""] =
      token.split(".");

    const header = yield* decodePart(Header, headerText);
    const claims = yield* decodePart(Claims, claimsText);
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

    if (claims.aud !== request.audience) {
      return yield* refuse(
        `the token's aud is ${claims.aud}, but this host is ${request.audience}. ${MINT}`
      );
    }

    if (claims.lxm !== request.lxm) {
      return yield* refuse(
        `the token's lxm is ${claims.lxm}, but this request calls ${request.lxm}. A token is good for one capability. ${MINT}`
      );
    }

    if (
      claims.iat > now + SKEW_SECONDS ||
      claims.exp <= now ||
      claims.exp - claims.iat > WINDOW_SECONDS
    ) {
      return yield* refuse(
        `the token is outside its time window (issued ${claims.iat}, expires ${claims.exp}, host time ${now}). ${MINT}`
      );
    }

    const kid = header.kid ?? "#atproto";
    const resolver = yield* DidResolver;

    const key = yield* resolver
      .resolve(claims.iss, `${claims.iss}${kid}`, "authentication")
      .pipe(
        Effect.mapError(
          () =>
            new AuthRefused({
              reason: `${claims.iss} is not a caller this host knows, or its document has no authentication key ${kid}. Ask the Mischief desk (pi-durable/desk) to add your DID document to the host's callers`,
            })
        )
      );

    const signature = yield* Effect.try({
      catch: () =>
        new AuthRefused({
          reason: `the token's signature is not base64url. ${MINT}`,
        }),
      try: () => unbase64url(signatureText),
    });

    const verified =
      lowS(signature) &&
      (yield* Effect.tryPromise({
        catch: () =>
          new AuthRefused({
            reason: `the token's signature could not be checked. ${MINT}`,
          }),
        try: async () =>
          await crypto.subtle.verify(
            { hash: "SHA-256", name: "ECDSA" },
            key,
            new Uint8Array(signature),
            new TextEncoder().encode(`${headerText}.${claimsText}`)
          ),
      }));

    if (!verified) {
      return yield* refuse(
        `the token's signature does not verify against ${claims.iss}'s key ${kid}. Sign with that key, in low-S form`
      );
    }

    const tokens = yield* ServiceTokens;

    if (!(yield* tokens.consume(claims, now))) {
      return yield* refuse(
        `this token (jti ${claims.jti}) was already used. Every request needs a fresh jti. ${MINT}`
      );
    }

    return claims;
  }
);
