import { Schema } from "effect";

export class CompletionLost extends Schema.TaggedError<CompletionLost>()(
  "CompletionLost",
  { key: Schema.String, runId: Schema.String, type: Schema.String }
) {
  override get message() {
    return `run ${this.runId}'s checkpoint holds an unconsumed ${this.type} event whose output is stored under journal key ${this.key}, and the journal has no entry there, so the run cannot resume with the value that step returned. The journal row was deleted after the checkpoint that names it was committed. Restore the run's journal from a backup, or abortRun({ runId: "${this.runId}" }) and submitPlan it as a new run.`;
  }
}
