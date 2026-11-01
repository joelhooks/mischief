import { Clock, DateTime, Effect, Option } from "effect";
import type { Scope } from "effect";

import type { PostboxFailed } from "./postbox-failed.js";
import { LONG_POLL_MS } from "./postbox-inbox.js";
import type { MarksPort, ReaderMarks } from "./postbox-reader-marks.js";
import { PostboxReader, readerTurn } from "./postbox-reader.js";

export const IDLE_AFTER_TURNS = 3;

export const IDLE_POLL_MS = 60_000;

export const BEHIND_MS = 15 * 60_000;

export interface AlarmPort {
  readonly get: Effect.Effect<Option.Option<number>>;
  readonly set: (at: number) => Effect.Effect<void>;
}

export interface MailboxHead {
  readonly cursor: number;
  readonly head: number;
}

export interface Lookout {
  readonly head: Effect.Effect<MailboxHead, PostboxFailed>;
  readonly notice: (summary: string, body: string) => Effect.Effect<boolean>;
}

export const windowFor = ({ emptyTurns }: ReaderMarks) =>
  emptyTurns >= IDLE_AFTER_TURNS ? IDLE_POLL_MS : LONG_POLL_MS;

const freshMarks = (now: number): ReaderMarks => ({
  emptyTurns: 0,
  lastReadAt: now,
  noticed: false,
});

const behindNotice = (
  marks: ReaderMarks,
  ended: number,
  problem: string,
  { cursor, head }: MailboxHead
) => {
  const minutes = Math.floor((ended - marks.lastReadAt) / 60_000);

  return {
    body: `The Postbox reader's last good read was at ${DateTime.formatIso(DateTime.makeUnsafe(marks.lastReadAt))}, ${minutes} min ago. The mailbox head is seq ${head} and the reader has taken mail through seq ${cursor}, so mail is waiting. Last error: ${problem}\n\nThe reader keeps retrying on its alarm; this is the one notice for this outage, and the next good read clears it. Next check: the celld journal for the Postbox's reader warnings, then probe MISCHIEF_MAILBOX_URL from the celld host.`,
    summary: `mischief/worker's Postbox reader is ${minutes} min behind: mailbox head seq ${head}, read through seq ${cursor}`,
  };
};

export const readerHost = (
  alarms: AlarmPort,
  store: MarksPort,
  lookout: Lookout,
  reader: (turn: Scope.Scope) => PostboxReader["Service"]
) => {
  const turn = (window: number) =>
    Effect.scopedWith((scope) =>
      readerTurn(window).pipe(
        Effect.provideService(PostboxReader, reader(scope))
      )
    );

  const noticeBehind = (marks: ReaderMarks, ended: number, problem: string) =>
    marks.noticed || ended - marks.lastReadAt <= BEHIND_MS
      ? Effect.succeed(marks.noticed)
      : lookout.head.pipe(
          Effect.tapError(({ reason }) =>
            Effect.logWarning(
              `the Postbox reader could not probe the mailbox head (${reason}), so it sent no fallen-behind notice this turn`
            )
          ),
          Effect.option,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: (probed) => {
                if (probed.head <= probed.cursor) {
                  return Effect.succeed(false);
                }

                const { body, summary } = behindNotice(
                  marks,
                  ended,
                  problem,
                  probed
                );

                return lookout.notice(summary, body);
              },
            })
          )
        );

  return {
    alarm: Effect.gen(function* postboxAlarm() {
      const started = yield* Clock.currentTimeMillis;

      const marks = Option.getOrElse(yield* store.get, () =>
        freshMarks(started)
      );

      const window = windowFor(marks);
      yield* alarms.set(started + window);

      const { ending, problem } = yield* turn(window);
      const ended = yield* Clock.currentTimeMillis;

      if (ending === "more" || ending === "idle") {
        yield* store.set({
          emptyTurns:
            ending === "idle"
              ? Math.min(marks.emptyTurns + 1, IDLE_AFTER_TURNS)
              : 0,
          lastReadAt: ended,
          noticed: false,
        });

        if (ending === "more") {
          yield* alarms.set(ended);
        }

        return ending;
      }

      const noticed = yield* noticeBehind(marks, ended, problem);
      yield* store.set({ ...marks, emptyTurns: 0, noticed });

      return ending;
    }),
    start: Effect.gen(function* ensureReaderAlarm() {
      const now = yield* Clock.currentTimeMillis;

      if (Option.isNone(yield* store.get)) {
        yield* store.set(freshMarks(now));
      }

      const armed = yield* alarms.get;

      if (Option.isNone(armed)) {
        yield* alarms.set(now);
      }
    }),
  };
};
