import { Cron, Data, Predicate, Result } from "effect";

import type { Docs, RunReport } from "../runs/schema.js";
import { terminalStatuses } from "../runs/schema.js";
import { HISTORY, wakeRunId } from "./schema.js";
import type { Cadence, EndReason, ScheduleState } from "./schema.js";

export const DONE_DOC = "done";

export const CONFIRM_MS = 60_000;

export type Previous = Data.TaggedEnum<{
  None: Record<never, never>;
  Missing: Record<never, never>;
  Reported: { readonly report: RunReport };
}>;

export const previous = Data.taggedEnum<Previous>();

export interface Start {
  readonly runId: string;
  readonly docs: Docs;
}

export interface Decision {
  readonly state: ScheduleState;
  readonly start: Start | null;
  readonly alarmAt: number | null;
}

export const parseCron = (expression: string) => Cron.parse(expression, "UTC");

export const slotAfter = (
  cadence: Cadence,
  anchor: number,
  after: number
): number => {
  if (Predicate.isTagged(cadence, "every")) {
    return (
      anchor + (Math.floor((after - anchor) / cadence.ms) + 1) * cadence.ms
    );
  }

  return Result.match(parseCron(cadence.expression), {
    onFailure: () => Number.MAX_SAFE_INTEGER,
    onSuccess: (cron) => Cron.next(cron, after).getTime(),
  });
};

export const firstSlot = (cadence: Cadence, createdAt: number) =>
  Predicate.isTagged(cadence, "every")
    ? createdAt
    : slotAfter(cadence, createdAt, createdAt);

export const alarmFor = (state: ScheduleState): number | null => {
  if (state.ended !== null) {
    return null;
  }

  return state.endsAt === null
    ? state.nextAt
    : Math.min(state.nextAt, state.endsAt);
};

const confirming = (state: ScheduleState, now: number) => {
  const at = alarmFor(state);

  return at === null ? null : Math.min(at, now + CONFIRM_MS);
};

const recent = <A>(items: readonly A[], item: A) =>
  [...items, item].slice(-HISTORY);

const end = (
  state: ScheduleState,
  now: number,
  reason: EndReason,
  detail: string
): Decision => ({
  alarmAt: null,
  start: null,
  state: { ...state, ended: { at: now, detail, reason } },
});

const stay = (state: ScheduleState): Decision => ({
  alarmAt: alarmFor(state),
  start: null,
  state,
});

const lastWake = (state: ScheduleState) => state.wakes.at(-1);

const named = (state: ScheduleState) => {
  const wake = lastWake(state);

  return `wake ${String(wake?.n)} (${String(wake?.runId)})`;
};

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many;

const carried = (
  state: ScheduleState,
  report: RunReport
): Result.Result<Docs, string> => {
  const { docs } = report;
  const absent = state.carry.filter((name) => !Object.hasOwn(docs, name));

  if (absent.length > 0) {
    const them = plural(absent.length, "it", "them");

    return Result.fail(
      `${named(state)} ended without the carry ${plural(absent.length, "doc", "docs")} ${absent.map((name) => `"${name}"`).join(", ")}. Have the plan write ${them} on every path, or create the schedule again without ${them} in carry`
    );
  }

  return Result.succeed({
    ...state.docs,
    ...Object.fromEntries(
      state.carry.flatMap((name) => {
        const doc = docs[name];

        return doc === undefined ? [] : [[name, doc] as const];
      })
    ),
  });
};

const wake = (state: ScheduleState, now: number, docs: Docs): Decision => {
  const n = state.wakeCount + 1;
  const runId = wakeRunId(state.scheduleId, n);

  const woken: ScheduleState = {
    ...state,
    nextAt: slotAfter(state.cadence, state.createdAt, now),
    pendingDocs: docs,
    wakeCount: n,
    wakes: recent(state.wakes, { at: now, due: state.nextAt, n, runId }),
  };

  return {
    alarmAt: confirming(woken, now),
    start: { docs, runId },
    state: woken,
  };
};

const skip = (state: ScheduleState, now: number, report: RunReport) =>
  stay({
    ...state,
    nextAt: slotAfter(state.cadence, state.createdAt, now),
    skipCount: state.skipCount + 1,
    skips: recent(state.skips, {
      at: now,
      due: state.nextAt,
      reason: `${named(state)} is still ${report.status}`,
    }),
  });

const due = (state: ScheduleState, now: number, seen: Previous): Decision =>
  previous.$match(seen, {
    Missing: () => wake(state, now, state.docs),
    None: () => wake(state, now, state.docs),
    Reported: ({ report }) => {
      if (!terminalStatuses.has(report.status)) {
        return skip(state, now, report);
      }

      return Result.match(carried(state, report), {
        onFailure: (detail) => end(state, now, "failed", detail),
        onSuccess: (docs) => wake(state, now, docs),
      });
    },
  });

const limited = (
  state: ScheduleState,
  now: number,
  seen: Previous
): Decision | null => {
  if (state.endsAt !== null && now >= state.endsAt) {
    return end(
      state,
      now,
      "timeout",
      `reached its timeout after ${String(state.wakeCount)} wakes`
    );
  }

  if (
    Predicate.isTagged(seen, "Reported") &&
    Object.hasOwn(seen.report.docs, DONE_DOC)
  ) {
    return end(
      state,
      now,
      "done",
      `${named(state)} wrote the "${DONE_DOC}" doc`
    );
  }

  if (state.maxWakes !== null && state.wakeCount >= state.maxWakes) {
    return end(state, now, "cap", `ran all ${String(state.maxWakes)} wakes`);
  }

  return null;
};

export const decide = (
  state: ScheduleState,
  now: number,
  seen: Previous
): Decision => {
  const last = lastWake(state);

  if (state.ended !== null) {
    return stay(state);
  }

  if (Predicate.isTagged(seen, "Missing") && last !== undefined) {
    return {
      alarmAt: confirming(state, now),
      start: { docs: state.pendingDocs, runId: last.runId },
      state,
    };
  }

  const ended = limited(state, now, seen);

  if (ended !== null) {
    return ended;
  }

  return now < state.nextAt ? stay(state) : due(state, now, seen);
};
