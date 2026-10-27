import { Clock, Effect, Option } from "effect";
import type { Scope } from "effect";

import { LONG_POLL_MS } from "./postbox-inbox.js";
import { PostboxReader, readerTurn } from "./postbox-reader.js";

export interface AlarmPort {
  readonly get: Effect.Effect<Option.Option<number>>;
  readonly set: (at: number) => Effect.Effect<void>;
}

export const readerHost = (
  alarms: AlarmPort,
  reader: (turn: Scope.Scope) => PostboxReader["Service"]
) => {
  const turn = Effect.scopedWith((scope) =>
    readerTurn().pipe(Effect.provideService(PostboxReader, reader(scope)))
  );

  return {
    alarm: Effect.gen(function* postboxAlarm() {
      const started = yield* Clock.currentTimeMillis;
      yield* alarms.set(started + LONG_POLL_MS);

      const ending = yield* turn;

      if (ending === "more") {
        yield* alarms.set(yield* Clock.currentTimeMillis);
      }

      return ending;
    }),
    start: Effect.gen(function* ensureReaderAlarm() {
      const armed = yield* alarms.get;

      if (Option.isNone(armed)) {
        yield* alarms.set(yield* Clock.currentTimeMillis);
      }
    }),
  };
};
