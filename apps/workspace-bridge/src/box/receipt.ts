import { Effect } from "effect";
import * as Digest from "effect/crypto/Digest";

import { refusal } from "../protocol.js";

export const receiptKey = Effect.fn("Box.receiptKey")(function* receiptKey(
  requestId: string
) {
  const crypto = yield* Digest.Digest;

  const bytes = yield* crypto
    .digest(Digest.sha256, new TextEncoder().encode(requestId))
    .pipe(
      Effect.mapError(() =>
        refusal(
          "Request identity could not be hashed; using raw text as a filename could escape storage. Check host crypto and retry the same requestId.",
          503
        )
      )
    );

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
});
