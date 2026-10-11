import { defineContract } from "@mischief/capability/contract";
import { Schema } from "effect";

import { PlanRefused } from "../plans/validate.js";
import { AnswerRefused } from "./answer-refused.js";
import { DocsSchema, RunId, RunReportSchema } from "./schema.js";
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
  input: Schema.Struct({ runId }),
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
