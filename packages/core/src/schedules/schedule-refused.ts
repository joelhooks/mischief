import { Schema } from "effect";

export class ScheduleRefused extends Schema.TaggedError<ScheduleRefused>()(
  "ScheduleRefused",
  { errors: Schema.Array(Schema.String), scheduleId: Schema.String }
) {
  override get message() {
    return `Schedule ${this.scheduleId} refused, nothing was stored. Fix each problem and call createSchedule again:\n${this.errors.map((error) => `- ${error}`).join("\n")}`;
  }
}
