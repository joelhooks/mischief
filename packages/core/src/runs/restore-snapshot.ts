import { Option, Schema } from "effect";
import type { Snapshot } from "xstate";

const decodeEmptyLegacyTimers = Schema.decodeUnknownOption(
  Schema.Struct({ timers: Schema.Record(Schema.String, Schema.Never) })
);

export const restorePlanSnapshot = (
  persisted: Snapshot<unknown>
): Snapshot<unknown> =>
  Option.match(decodeEmptyLegacyTimers(persisted), {
    onNone: () => persisted,
    onSome: () => ({
      ...persisted,
      timers: [],
    }),
  });
