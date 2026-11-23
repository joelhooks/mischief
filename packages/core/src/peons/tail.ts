import { defineContract } from "@mischief/capability/contract";
import { Schema } from "effect";

import { PeonId, PeonRefused, PeonState, PeonUsage } from "./schema.js";
import { PeonTailForbidden } from "./tail-forbidden.js";
import { PeonTailNotFound } from "./tail-not-found.js";

export { PeonTailForbidden, PeonTailNotFound };

export const peonTailDefaultEntries = 30;

const peonTailMaxEntries = 200;

const Cursor = Schema.String.check(Schema.isPattern(/^b[1-9][0-9]{0,15}$/u));

export const PeonTailQuery = Schema.Struct({
  entries: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ maximum: peonTailMaxEntries, minimum: 1 })
    )
  ),
  sinceId: Schema.optionalKey(Cursor),
});

export const PeonTailEntryType = Schema.Literals([
  "session",
  "system",
  "user",
  "assistant",
  "toolResult",
  "compaction",
  "blob",
  "other",
]);

const TailPage = Schema.Struct({
  status: Schema.Literal("tail"),
  entries: Schema.Array(
    Schema.Struct({
      bytes: Schema.Int.check(Schema.isGreaterThan(0)),
      id: Cursor,
      type: PeonTailEntryType,
    })
  ).check(Schema.isMaxLength(peonTailMaxEntries)),
  truncated: Schema.Boolean,
});

const NotLive = Schema.Struct({
  status: Schema.Literal("not-live"),
  reason: Schema.Literals(["hibernated", "destroyed", "absent", "no-session"]),
});

export const BoxTailResult = Schema.Union([TailPage, NotLive]);

export const PeonTailContext = Schema.Struct({
  peonId: PeonId,
  state: PeonState,
  lastTurn: Schema.NullOr(
    Schema.Struct({
      exit: Schema.Finite,
      resumeMs: Schema.optionalKey(Schema.Finite),
      toolCallCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      usage: PeonUsage,
      wallMs: Schema.Finite,
    })
  ),
});

export const tailPeonContract = defineContract("tailPeon", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "Read recent managed Pi activity as entry types and byte counts, without session text or tool payloads. Pass an entry id as sinceId to see only newer entries. Never wakes a box.",
  failure: Schema.Union([PeonRefused, PeonTailNotFound, PeonTailForbidden]),
  input: Schema.Struct({ peonId: PeonId, ...PeonTailQuery.fields }),
  output: Schema.Union([
    Schema.Struct({ ...PeonTailContext.fields, ...TailPage.fields }),
    Schema.Struct({ ...PeonTailContext.fields, ...NotLive.fields }),
  ]),
});
