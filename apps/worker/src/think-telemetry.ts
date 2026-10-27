import { ThinkTelemetry } from "@mischief/core";
import type { ThinkDaySchema } from "@mischief/core";
import { THINK_DEFAULT, THINK_DEFAULT_REVIEW } from "@mischief/thinking";
import { Clock, Effect } from "effect";

import {
  RUN_WARN_CALL_TOKENS,
  RUN_WARN_STEP_REPEATS,
  utcDay,
} from "./think-tally.js";

export interface HostTelemetry {
  readonly model: string;
  readonly cliproxyKey?: string | undefined;
  readonly cliproxyUrl?: string | undefined;
  readonly readDay: (day: string) => Effect.Effect<typeof ThinkDaySchema.Type>;
}

export const thinkTelemetry = ({
  cliproxyKey,
  cliproxyUrl,
  model,
  readDay,
}: HostTelemetry) =>
  ThinkTelemetry.of({
    read: Effect.gen(function* readThinkTelemetry() {
      const day = utcDay(yield* Clock.currentTimeMillis);
      const today = yield* readDay(day);

      return {
        default: {
          ...THINK_DEFAULT,
          review: THINK_DEFAULT_REVIEW,
          source:
            "THINK_DEFAULT in @mischief/thinking; design ledger 2026-10-16",
        },
        host: {
          model,
          wired:
            model === "faux" ||
            (model === "cliproxy" &&
              (cliproxyKey ?? "") !== "" &&
              (cliproxyUrl ?? "") !== ""),
        },
        today: {
          ...today,
          day,
          warnAt: {
            call: RUN_WARN_CALL_TOKENS,
            day: today.warning.line,
            stepRepeats: RUN_WARN_STEP_REPEATS,
          },
        },
      };
    }),
  });
