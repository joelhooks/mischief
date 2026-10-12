import { Context } from "effect";
import type { Effect } from "effect";

export class ScheduleAlarm extends Context.Service<
  ScheduleAlarm,
  { readonly set: (at: number | null) => Effect.Effect<void> }
>()("@mischief/core/ScheduleAlarm") {}
