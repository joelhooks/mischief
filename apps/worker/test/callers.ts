// @effect-diagnostics asyncFunction:off -- WebCrypto key generation and export are Promise APIs.
import { base64url, serviceToken } from "@rat-king/mailbox-client/auth";
import type { DocumentsValue } from "@rat-king/mailbox-client/auth";
import { Clock, Effect } from "effect";

export const MISCHIEF_DID = "did:web:mischief.ratking-fleet.invalid";

export const AUDIENCE = `${MISCHIEF_DID}#mischief`;

export interface Caller {
  readonly did: string;
  readonly document: DocumentsValue[number];
  readonly key: CryptoKey;
}

export interface ClaimsChange {
  readonly aud?: string;
  readonly exp?: number;
  readonly iat?: number;
  readonly jti?: string;
  readonly lxm?: string;
}

export const freshCaller = (name: string) =>
  Effect.gen(function* generateCaller() {
    const did = `did:web:${name}.ratking-fleet.invalid`;

    const pair = yield* Effect.promise(
      async () =>
        await crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign", "verify"]
        )
    );

    if (!("privateKey" in pair)) {
      return yield* Effect.die("ECDSA key generation returned a single key");
    }

    const jwk = yield* Effect.promise(
      async () => await crypto.subtle.exportKey("jwk", pair.publicKey)
    );

    if (!("x" in jwk)) {
      return yield* Effect.die("a JWK export returned raw bytes");
    }

    return {
      did,
      document: {
        authentication: [`${did}#atproto`],
        id: did,
        keyAgreement: [],
        verificationMethod: [
          {
            controller: did,
            id: `${did}#atproto`,
            publicKeyJwk: {
              crv: "P-256",
              kty: "EC",
              x: jwk.x ?? "",
              y: jwk.y ?? "",
            },
          },
        ],
      },
      key: pair.privateKey,
    } satisfies Caller;
  });

export const bearer = (
  caller: Caller,
  capability: string,
  change: ClaimsChange = {}
) =>
  Effect.gen(function* signBearer() {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

    const token = yield* serviceToken(
      {
        aud: change.aud ?? AUDIENCE,
        exp: change.exp ?? now + 30,
        iat: change.iat ?? now,
        iss: caller.did,
        jti:
          change.jti ?? base64url(crypto.getRandomValues(new Uint8Array(16))),
        lxm: change.lxm ?? `sh.mschf.mischief.${capability}`,
      },
      caller.key
    ).pipe(Effect.orDie);

    return `Bearer ${token}`;
  });
