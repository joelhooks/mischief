// @effect-diagnostics asyncFunction:off -- crypto.subtle.digest is a Promise API at this adapter boundary.
import { Crypto, Effect, Layer, PlatformError } from "effect";

const digest = (algorithm: Crypto.DigestAlgorithm, data: Uint8Array) =>
  Effect.tryPromise({
    catch: (cause) =>
      PlatformError.systemError({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- systemError takes the SystemError kind as a field named _tag; this is Effect's constructor, not a literal union member.
        _tag: "Unknown",
        cause,
        description: "Could not compute digest",
        method: "digest",
        module: "Crypto",
      }),
    try: async () =>
      await crypto.subtle.digest(algorithm, new Uint8Array(data)),
  }).pipe(Effect.map((buffer) => new Uint8Array(buffer)));

export const webCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    digest,
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  })
);
