import { Schema } from "effect";

export class RunLeftUncommitted extends Schema.TaggedError<RunLeftUncommitted>()(
  "RunLeftUncommitted",
  { runId: Schema.String, writes: Schema.Array(Schema.String) }
) {
  override get message() {
    return `run ${this.runId}'s unit of work closed with writes nobody committed or discarded (${this.writes.join(", ")}). Commit or discard before the unit ends; withinRun does both.`;
  }
}
