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

const ADVANCING = new Set([
  "submitPlan",
  "resumeRun",
  "answerRun",
  "deliverReply",
  "extendRun",
]);

export const callAndDrive = (
  run: PlanRun,
  capability: string,
  body: Schema.Json
) =>
  Effect.gen(function* inlineDrive() {
    const stored = yield* call(run, capability, body);

    if (stored.status !== 200 || !ADVANCING.has(capability)) {
      return stored;
    }

    const { runId } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ runId: Schema.String })
    )(stored.body);

    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const controller = new AbortController();
        const promise = run.alarm(controller.signal);

        return { controller, promise };
      }),
      ({ promise }) =>
        Effect.promise(async () => {
          await promise;
        }),
      ({ controller, promise }) =>
        Effect.promise(async () => {
          controller.abort();
          await Promise.allSettled([promise]);
        })
    );

    return yield* call(run, "inspectRun", { runId });
  });

const ReportSchema = Schema.Struct({
  awaiting: Schema.optionalKey(
    Schema.Array(Schema.Struct({ messageId: Schema.String }))
  ),
  docs: Schema.Record(Schema.String, Schema.Json),
  status: Schema.String,
});

export const decodeReport = Schema.decodeUnknownSync(ReportSchema);
