import { Schema } from "effect";

import { PeonId, PeonState } from "../peons/schema.js";

export const WatchId = Schema.String.check(
  Schema.isPattern(/^watch-[a-f0-9]{64}$/u)
);

export const WatchOwner = Schema.String.check(
  Schema.isPattern(/^did:[a-z0-9]+:\S+$/u)
);

export const WatchName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/u),
  Schema.isMaxLength(128)
);

export const WatchState = Schema.Literals([
  "armed",
  "checking",
  "fired",
  "done",
  "cancelled",
  "expired",
]);

export const Cursor = Schema.String;

export const Evidence = Schema.Struct({
  at: Schema.Finite,
  text: Schema.String,
});

export const Condition = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    url: Schema.String.check(Schema.isMaxLength(2048)),
    expect: Schema.Struct({
      status: Schema.optionalKey(Schema.Int),
      jsonPath: Schema.optionalKey(
        Schema.String.check(Schema.isMaxLength(256))
      ),
      equals: Schema.optionalKey(Schema.Json),
      regex: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("peon"),
    peonId: PeonId,
    expect: Schema.Struct({
      state: Schema.optionalKey(PeonState),
      pendingClear: Schema.optionalKey(Schema.Literal(true)),
    }),
  }),
]);

export const Notify = Schema.Struct({
  to: Schema.Array(WatchName),
  cc: Schema.Array(WatchName),
});

export const WatchDefinition = Schema.Struct({
  kind: Schema.Literals(["once", "repeat"]),
  condition: Condition,
  intervalSeconds: Schema.Int,
  timeoutSeconds: Schema.Int,
  notify: Notify,
  message: Schema.Struct({
    summary: Schema.String.check(Schema.isMaxLength(280)),
    body: Schema.String.check(Schema.isMaxLength(20_000)),
  }),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export const WatchSummary = Schema.Struct({
  watchId: WatchId,
  owner: WatchOwner,
  label: WatchDefinition.fields.label,
  kind: WatchDefinition.fields.kind,
  notify: Notify,
  state: WatchState,
  armedAt: Schema.Finite,
  expiresAt: Schema.Finite,
});

export const Watch = Schema.Struct({
  ...WatchSummary.fields,
  ...WatchDefinition.fields,
});

export const WatchCheck = Schema.Struct({
  at: Schema.Finite,
  outcome: Schema.Literals(["true", "false", "checkError"]),
  detail: Schema.String,
});

export const WatchFiring = Schema.Struct({
  at: Schema.Finite,
  cursor: Cursor,
  messageId: Schema.String,
  downgraded: Schema.Array(WatchName),
});

export const WatchInspection = Schema.Struct({
  watch: Watch,
  lastCheck: Schema.NullOr(WatchCheck),
  cursor: Schema.NullOr(Cursor),
  evidence: Schema.Array(Evidence),
  firings: Schema.Array(WatchFiring),
});

export class WatchRefused extends Schema.TaggedError<WatchRefused>()(
  "WatchRefused",
  {
    code: Schema.Literals([
      "BadCondition",
      "HostNotAllowed",
      "TooManyTargets",
      "IntervalTooShort",
      "NotOwner",
      "UnknownWatch",
      "NotGranted",
    ]),
    reason: Schema.String,
  }
) {
  override get message() {
    return this.reason;
  }
}
