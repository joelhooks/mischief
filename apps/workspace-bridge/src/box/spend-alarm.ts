import { Console, Effect } from "effect";

import { refusal } from "../protocol.js";
import { checked, Runner } from "../runner.js";
import type { SpendAlarm } from "./spend-ledger.js";

export const logSpend = (alarm: SpendAlarm) =>
  Console.error(JSON.stringify({ event: "peon_spend_alarm", ...alarm }));

export const notifySpend = (
  runner: Runner["Service"],
  sender: string,
  executable: string
) =>
  Effect.fnUntraced(function* deliverAlarm(alarm: SpendAlarm) {
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
      Effect.mapError(() =>
        refusal(
          "Rat King did not confirm the spend alert. Inspect the manager's sender and mailbox connection; the outbox will retry.",
          503
        )
      ),
      Effect.tapError(() =>
        Console.error(
          JSON.stringify({
            event: "peon_spend_mail_failed",
            peonId: alarm.peonId,
            metric: alarm.metric,
            day: alarm.day,
          })
        )
      )
    );
  });
