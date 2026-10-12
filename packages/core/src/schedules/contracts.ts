import { defineContract } from "@mischief/capability/contract";
import { Schema } from "effect";

import { DocsSchema } from "../runs/schema.js";
import { ScheduleRefused } from "./schedule-refused.js";
import { ScheduleId, ScheduleReportSchema } from "./schema.js";
import { UnknownSchedule } from "./unknown-schedule.js";

const scheduleId = ScheduleId.annotate({
  description: "Schedule id, lowercase kebab-case, up to 48 characters",
});

export const createScheduleContract = defineContract("createSchedule", {
  annotations: { idempotent: true, openWorld: true },
  description:
    'Wake a fresh run of one plan on a cadence, one wake at a time, until completeSchedule, a "done" doc, maxWakes or the timeout. Wake n is the run "<scheduleId>-wake-<n>"; a slot whose previous wake is still going is skipped, and missed slots collapse to one wake. Creating an existing schedule id returns it unchanged.',
  failure: ScheduleRefused,
  input: Schema.Struct({
    carry: Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        description:
          "Doc names each wake passes to the next; each needs a starting value in docs",
      })
    ),
    cron: Schema.optionalKey(
      Schema.String.annotate({
        description: 'Five cron fields in UTC, such as "0 9 * * 1-5"',
      })
    ),
    docs: Schema.optionalKey(
      DocsSchema.annotate({ description: "Seed docs for every wake" })
    ),
    every: Schema.optionalKey(
      Schema.String.annotate({
        description: 'A duration of at least 1 minute, such as "30 minutes"',
      })
    ),
    maxWakes: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThan(0)).annotate({
        description: "The most wakes before the schedule ends",
      })
    ),
    plan: Schema.Json.annotate({
      description: "The plan every wake runs, as JSON",
    }),
    scheduleId,
    timeout: Schema.optionalKey(
      Schema.String.annotate({
        description: 'How long the schedule may live, such as "7 days"',
      })
    ),
  }),
  output: ScheduleReportSchema,
});

export const inspectScheduleContract = defineContract("inspectSchedule", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "Report a schedule's cadence, its recent wakes and skips with counts, when it wakes next, and why it ended",
  failure: UnknownSchedule,
  input: Schema.Struct({ scheduleId }),
  output: ScheduleReportSchema,
});

export const completeScheduleContract = defineContract("completeSchedule", {
  annotations: { destructive: true, idempotent: true },
  description:
    "End a schedule for good; a wake already running finishes, and its runs stay readable",
  failure: UnknownSchedule,
  input: Schema.Struct({ scheduleId }),
  output: ScheduleReportSchema,
});
