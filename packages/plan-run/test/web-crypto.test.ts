import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Crypto, Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { webCrypto } from "../src/web-crypto.js";

const digestWith = (
  algorithm: Crypto.DigestAlgorithm,
  data: Uint8Array,
  layer: typeof webCrypto
) =>
  Crypto.Crypto.use((service) => service.digest(algorithm, data)).pipe(
    Effect.provide(layer)
  );

it.effect.prop(
  "Web Crypto digests what Node digests, so a run's fingerprints agree on every host",
  {
    algorithm: Arbitrary.schema(
      Schema.Literals(["SHA-1", "SHA-256", "SHA-384", "SHA-512"])
    ),
    data: Arbitrary.schema(
      Schema.Array(
        Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 }))
      )
    ),
  },
  ({ algorithm, data }) =>
    Effect.gen(function* property() {
      const bytes = Uint8Array.from(data);

      expect(yield* digestWith(algorithm, bytes, webCrypto)).toEqual(
        yield* digestWith(algorithm, bytes, NodeCrypto.layer)
      );
    }),
  { arbitrary: { runs: 100 }, timeout: 120_000 }
);

it.effect(
  "Web Crypto random bytes have the size asked for and differ draw to draw",
  () =>
    Effect.gen(function* draws() {
      const crypto = yield* Crypto.Crypto;
      const first = yield* crypto.randomBytes(32);
      const second = yield* crypto.randomBytes(32);

      expect(first).toHaveLength(32);
      expect(first).not.toEqual(second);
    }).pipe(Effect.provide(webCrypto))
);
