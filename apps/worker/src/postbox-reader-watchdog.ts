import type { EffectActor } from "@xstate/effect";
import { send, waitFor } from "@xstate/effect";
import { Effect, Option } from "effect";

import type { postboxReaderMachine } from "./postbox-reader.js";

export const postboxReaderWatchdog = (
  actor: EffectActor<typeof postboxReaderMachine>
) => {
  const before = actor.getSnapshot();

  if (
    before.matches("consuming") ||
    before.matches("wiring") ||
    before.status === "done"
  ) {
    return Option.none();
  }

  return Option.some(
    send(actor, { type: "WATCHDOG" }).pipe(
      Effect.andThen(
        waitFor(
          actor,
          (snapshot) =>
            snapshot !== before &&
            (snapshot.matches("dbMissing") ||
              snapshot.matches("retrying") ||
              snapshot.matches("stopped"))
        )
      ),
      Effect.asVoid
    )
  );
};
