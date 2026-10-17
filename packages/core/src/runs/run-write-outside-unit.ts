import { Schema } from "effect";

export class RunWriteOutsideUnit extends Schema.TaggedError<RunWriteOutsideUnit>()(
  "RunWriteOutsideUnit",
  { runId: Schema.String, write: Schema.String }
) {
  override get message() {
    return `${this.write} for run ${this.runId} came outside a unit of work, so it would never be committed. Go through RunHost, or wrap the writes in withinRun(store, "${this.runId}").`;
  }
}
