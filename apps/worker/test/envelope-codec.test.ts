import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { decodeEnvelope, encodeEnvelope } from "../src/mailroom.js";

const Bytes = Schema.Array(
  Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 }))
).check(Schema.isMinLength(1), Schema.isMaxLength(64));

it.effect.prop(
  "a stored envelope decodes to exactly the envelope that was sealed, bytes included",
  {
    ciphertext: Arbitrary.schema(Bytes),
    enc: Arbitrary.schema(Bytes),
    messageId: Arbitrary.schema(Schema.String),
  },
  ({ ciphertext, enc, messageId }) =>
    Effect.gen(function* roundTrip() {
      const envelope = {
        aad: {
          messageId,
          recipientDid: "did:web:alpha.invalid",
          recipientKeyId: "did:web:alpha.invalid#encryption",
          senderDid: "did:web:mischief.worker.invalid",
        },
        ciphertext: Uint8Array.from(ciphertext),
        enc: Uint8Array.from(enc),
        suite: { aeadId: 1, kdfId: 1, kemId: 16 },
        version: 1,
      };

      const sealed: Parameters<typeof encodeEnvelope>[0] =
        // SAFETY: a structurally complete envelope; the codec only moves the two byte fields.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        envelope as Parameters<typeof encodeEnvelope>[0];

      const text = encodeEnvelope(sealed);

      const decoded = yield* decodeEnvelope(text);

      expect(decoded).toStrictEqual(envelope);
    })
);
