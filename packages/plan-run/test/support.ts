// @effect-diagnostics asyncFunction:off -- the alarm port and fetch are the Durable Object's Promise surface.
import { Effect, Schema } from "effect";

import type { Alarms, PlanRun } from "../src/plan-run.js";

export interface AlarmLog {
  pending: number | null;
  sets: number;
}

export const alarmsFor = (log: AlarmLog): Alarms => ({
  clear: async () => {
    log.pending = await Promise.resolve(null);
  },
  get: async () => await Promise.resolve(log.pending),
  set: async (at) => {
    log.pending = await Promise.resolve(at);
    log.sets += 1;
  },
});

export const call = (run: PlanRun, capability: string, body: Schema.Json) =>
  Effect.promise(async () => {
    const response = await run.fetch(
      new Request(`http://plan-run/${capability}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );

    return { body: await response.json(), status: response.status };
  });

const ReportSchema = Schema.Struct({
  awaiting: Schema.optionalKey(
    Schema.Array(Schema.Struct({ messageId: Schema.String }))
  ),
  docs: Schema.Record(Schema.String, Schema.Json),
  status: Schema.String,
});

export const decodeReport = Schema.decodeUnknownSync(ReportSchema);
