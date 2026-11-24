import { Console, Effect } from "effect";

import { checked, Runner } from "../runner.js";
import type { SpendAlarm } from "./spend-ledger.js";

export const notifySpend = (
  runner: Runner["Service"],
  sender: string,
  executable: string
) =>
  Effect.fnUntraced(function* deliverAlarm(alarm: SpendAlarm) {
    const payload = JSON.stringify({ event: "peon_spend_alarm", ...alarm });
    yield* Console.error(payload);

    const window =
      alarm.metric === "rate" ? "rolling-minute requests" : "daily tokens";

    const summary = `Peon ${alarm.peonId} used ${alarm.used} of ${alarm.limit} ${window}.`;
    yield* checked({
      args: [
        "send",
        "--as",
        sender,
        "--to",
        "peons/desk",
        "--summary",
        summary,
        "--body",
        `${summary} Inspect host model spend before retrying.\n\nSR 🐀`,
      ],
      executable,
    }).pipe(
      Effect.provideService(Runner, runner),
      Effect.timeout("15 seconds"),
      Effect.catch(() =>
        Console.error(
          JSON.stringify({
            event: "peon_spend_mail_failed",
            peonId: alarm.peonId,
            metric: alarm.metric,
            day: alarm.day,
          })
        )
      ),
      Effect.interruptible,
      Effect.forkDetach
    );
  });
