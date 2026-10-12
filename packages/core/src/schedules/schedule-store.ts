import { Context } from "effect";
import type { Effect, Option } from "effect";

import type { ScheduleState } from "./schema.js";

export class ScheduleStore extends Context.Service<
  ScheduleStore,
  {
    readonly load: Effect.Effect<Option.Option<ScheduleState>>;
    readonly save: (state: ScheduleState) => Effect.Effect<void>;
  }
>()("@mischief/core/ScheduleStore") {}
