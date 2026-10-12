import { Schema } from "effect";

export class UnknownSchedule extends Schema.TaggedError<UnknownSchedule>()(
  "UnknownSchedule",
  { scheduleId: Schema.String }
) {
  override get message() {
    return `No schedule named "${this.scheduleId}". Check the scheduleId, or start one with createSchedule({ scheduleId, plan, every or cron, maxWakes or timeout }).`;
  }
}
