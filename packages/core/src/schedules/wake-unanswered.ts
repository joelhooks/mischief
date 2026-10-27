import { Schema } from "effect";

export class WakeUnanswered extends Schema.TaggedError<WakeUnanswered>()(
  "WakeUnanswered",
  {
    reason: Schema.String,
    runId: Schema.String,
    scheduleId: Schema.String,
    step: Schema.Literals(["abortRun", "inspectRun", "submitPlan"]),
  }
) {
  override get message() {
    return `${this.step} ${this.runId} ${this.reason}, so schedule "${this.scheduleId}" could not finish its wake. The wake alarm fails and the Durable Object retries it. To look now, call inspectRun {"runId":"${this.runId}"} and inspectSchedule {"scheduleId":"${this.scheduleId}"}.`;
  }
}
