import type { EndNotice } from "./schedule-notices.js";
import type { Ended, ScheduleState } from "./schema.js";

export const endNoticeKey = (scheduleId: string) =>
  `schedule-ended:${scheduleId}`;

export const endNoticeText = (state: ScheduleState, ended: Ended) => {
  const lastRunId = state.wakes.at(-1)?.runId ?? null;

  return [
    `Mischief schedule ${state.scheduleId} ended (${ended.reason}): ${ended.detail}. It will not wake again.`,
    `It ran ${String(state.wakeCount)} ${state.wakeCount === 1 ? "wake" : "wakes"}; the last run was ${lastRunId ?? "none"}.`,
    "",
    JSON.stringify({
      detail: ended.detail,
      lastRunId,
      reason: ended.reason,
      scheduleId: state.scheduleId,
      wakeCount: state.wakeCount,
    }),
    "",
    `Fix: inspectSchedule {"scheduleId": "${state.scheduleId}"} under the identity that created it shows the full report. To continue, create a new schedule with createSchedule under a new scheduleId.`,
  ].join("\n");
};

export const endNoticeOf = (state: ScheduleState, ended: Ended): EndNotice => ({
  escalateTo: state.escalateTo,
  key: endNoticeKey(state.scheduleId),
  scheduleId: state.scheduleId,
  text: endNoticeText(state, ended),
});
