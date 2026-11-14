import { webCrypto } from "@mischief/plan-run";
import { Effect } from "effect";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";

export const freshPeonId = SecureRandom.SecureRandom.use((service) =>
  service.uuidV4()
).pipe(Effect.provide(webCrypto));

export const hashPeonText = (text: string) =>
  Digest.Digest.use((service) =>
    service.digestHex(Digest.sha256, new TextEncoder().encode(text))
  ).pipe(Effect.provide(webCrypto));
