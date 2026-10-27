import { defineContract } from "@mischief/capability/contract";
import { Schema } from "effect";

import { ThinkTelemetryUnavailable } from "./telemetry-unavailable.js";

export const ThinkDaySchema = Schema.Struct({
  calls: Schema.Finite,
  tokens: Schema.Finite,
  warning: Schema.Struct({
    line: Schema.Finite,
    median: Schema.NullOr(Schema.Finite),
    multiple: Schema.Finite,
    sampleDays: Schema.Finite,
  }),
});

export const ThinkStatusSchema = Schema.Struct({
  default: Schema.Struct({
    ...Schema.Struct({ model: Schema.String, thinking: Schema.String }).fields,
    review: Schema.String,
    source: Schema.String,
  }),
  host: Schema.Struct({ model: Schema.String, wired: Schema.Boolean }),
  today: Schema.Struct({
    ...ThinkDaySchema.fields,
    day: Schema.String,
    warnAt: Schema.Struct({
      call: Schema.Finite,
      day: Schema.Finite,
      stepRepeats: Schema.Finite,
    }),
  }),
});

export const thinkStatusContract = defineContract("thinkStatus", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "Read host thinking defaults, model wiring, and UTC day telemetry",
  failure: ThinkTelemetryUnavailable,
  input: Schema.Struct({}),
  output: ThinkStatusSchema,
});
