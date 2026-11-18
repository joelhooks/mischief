import { Schema } from "effect";

export const DESK_HOST_PORT = 28_015;

export const DeskName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z][a-z0-9_-]{0,31}$/u),
  Schema.isMaxLength(128)
);

export const DeskMessageId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u)
);

export const DeskWakeBody = Schema.Struct({ messageId: DeskMessageId });

export const DeskWakeResult = Schema.Struct({
  inProgress: Schema.optionalKey(Schema.Literal(true)),
  permanent: Schema.optionalKey(Schema.Literal(true)),
  ready: Schema.optional(Schema.Boolean),
  reason: Schema.String,
  result: Schema.Literals(["restored", "lost", "failed"]),
});

export const DeskLease = Schema.Union([
  Schema.Struct({ live: Schema.Boolean }),
  Schema.Struct({ permanent: Schema.Literal(true), reason: Schema.String }),
]);

export const DeskInspection = Schema.Struct({
  alarmAt: Schema.NullOr(Schema.Int),
  attempts: Schema.Int,
  messageId: Schema.NullOr(DeskMessageId),
  pending: Schema.NullOr(
    Schema.Struct({ messageId: DeskMessageId, probeAt: Schema.Int })
  ),
  ready: Schema.NullOr(Schema.Boolean),
  reason: Schema.String,
  state: Schema.Literals([
    "asleep",
    "waking",
    "reading",
    "backoff",
    "wake-failed",
  ]),
});
