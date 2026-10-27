import { Context } from "effect";
import type { Effect } from "effect";

export interface EndNotice {
  readonly escalateTo: string | null;
  readonly key: string;
  readonly scheduleId: string;
  readonly text: string;
}

export class ScheduleNotices extends Context.Service<
  ScheduleNotices,
  { readonly ended: (notice: EndNotice) => Effect.Effect<void> }
>()("@mischief/core/ScheduleNotices") {}
