import { defineContract } from "@mischief/capability/contract";
import { Schema } from "effect";

import { PlanRefused } from "../plans/validate.js";
import { AnswerRefused } from "./answer-refused.js";
import { ExtendRefused } from "./extend-refused.js";
import { ReplyRefused } from "./reply-refused.js";
import { RevisionRefused } from "./revision-refused.js";
import {
  DocsSchema,
  EscalateToSchema,
  JudgeModeSchema,
  ReplyLineSchema,
  RevisionReportSchema,
  RunId,
  RunRecordSchema,
  RunReportSchema,
} from "./schema.js";
import { UnknownRun } from "./unknown-run.js";

const runId = RunId.annotate({ description: "Run id, lowercase kebab-case" });

export const submitPlanContract = defineContract("submitPlan", {
  annotations: { idempotent: true, openWorld: true },
  description:
    "Validate a plan, store it as version 1 of a new run with any seed docs, and drive the run until it finishes, waits for Joel, pauses or hits its envelope. Submitting an existing run id resumes that run and ignores docs.",
  failure: PlanRefused,
  input: Schema.Struct({
    docs: Schema.optionalKey(
      DocsSchema.annotate({
        description:
          "Seed docs, by name, that judge steps can list in reads; the plan stays the same across runs",
      })
    ),
    escalateTo: Schema.optionalKey(EscalateToSchema),
    judge: Schema.optionalKey(JudgeModeSchema),
    plan: Schema.Json.annotate({ description: "The plan, as JSON" }),
    runId,
  }),
  output: RunReportSchema,
});

export const inspectRunContract = defineContract("inspectRun", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "Report a run's status, current state, documents, and any open question",
  failure: UnknownRun,
  input: Schema.Struct({ runId }),
  output: RunReportSchema,
});

export const readRunContract = defineContract("readRun", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "Read a run's current plan and its whole journal in the order it was written, for viewers that draw the plan's states and what each step recorded",
  failure: UnknownRun,
  input: Schema.Struct({ runId }),
  output: RunRecordSchema,
});

export const pauseRunContract = defineContract("pauseRun", {
  annotations: { idempotent: true },
  description:
    "Ask a run to stop before its next transition; steps already running finish",
  failure: UnknownRun,
  input: Schema.Struct({ runId }),
  output: RunReportSchema,
});

export const resumeRunContract = defineContract("resumeRun", {
  annotations: { idempotent: true, openWorld: true },
  description: "Clear a pause and drive the run from its last checkpoint",
  failure: UnknownRun,
  input: Schema.Struct({ runId }),
  output: RunReportSchema,
});

export const abortRunContract = defineContract("abortRun", {
  annotations: { destructive: true, idempotent: true },
  description: "End a run for good; its checkpoint and documents stay readable",
  failure: UnknownRun,
  input: Schema.Struct({
    runId,
    supersededBy: Schema.optionalKey(
      RunId.annotate({
        description:
          "The run replacing this one. Each open ask gets one closing note naming it, so the asked desk stops treating the old ask as live",
      })
    ),
  }),
  output: RunReportSchema,
});

export const answerRunContract = defineContract("answerRun", {
  annotations: { openWorld: true },
  description:
    "Answer the question a run is waiting on with one of its listed options, then drive the run on",
  failure: Schema.Union([UnknownRun, AnswerRefused]),
  input: Schema.Struct({
    reply: Schema.String.annotate({ description: "One of the listed options" }),
    runId,
  }),
  output: RunReportSchema,
});

export const deliverReplyContract = defineContract("deliverReply", {
  annotations: { openWorld: true },
  description:
    "Deliver a Rat King reply to the run whose ask sent the message it answers, write it to the ask's doc, and drive the run on. Takes a drained mailbox line as-is; extra fields are ignored.",
  failure: ReplyRefused,
  input: ReplyLineSchema,
  output: RunReportSchema,
});

export const reviseRunContract = defineContract("reviseRun", {
  annotations: { openWorld: true },
  description:
    "Rebuild a run under a revised plan with the same envelope. Steps whose definition and input docs are unchanged reuse their recorded results; the rest run live, an unchanged ask keeps its message and reply, and Joel is asked again only after work changed. dryRun reports what would be reused and the first live step on each path without touching the run.",
  failure: Schema.Union([UnknownRun, RevisionRefused]),
  input: Schema.Struct({
    dryRun: Schema.Boolean.annotate({
      description:
        "Preview only: report reuse and the first live steps, change nothing",
    }),
    plan: Schema.Json.annotate({ description: "The revised plan, as JSON" }),
    runId,
  }),
  output: RevisionReportSchema,
});

export const extendRunContract = defineContract("extendRun", {
  annotations: { openWorld: true },
  description:
    "Raise a run's maxSteps when it paused at its envelope, record it as a new plan version, and drive the run on. The owner decides this; nothing a worker sees ever carries the limit.",
  failure: Schema.Union([UnknownRun, ExtendRefused]),
  input: Schema.Struct({
    maxSteps: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
      description: "The new step limit, above the current one",
    }),
    runId,
  }),
  output: RunReportSchema,
});
