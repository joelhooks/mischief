import { watchActor } from "@mischief/capability/actor-watch";
import {
  createEffectActor,
  createEffectLogic,
  setupEffect,
  waitFor,
} from "@xstate/effect";
import { Context, Effect } from "effect";
import { types } from "xstate";
import type { SnapshotFrom } from "xstate";

import type { openMailroom } from "./mailroom.js";
import { LONG_POLL_MS } from "./postbox-inbox.js";
import type { BatchOutcome } from "./postbox-inbox.js";
import type { PostboxReaderFailed } from "./postbox-reader-failed.js";

export type OpenMailroom = Effect.Success<ReturnType<typeof openMailroom>>;

export const READ_DEADLINE_MS = 2 * LONG_POLL_MS + 5000;

export class PostboxReader extends Context.Service<
  PostboxReader,
  {
    readonly read: (
      mailroom: OpenMailroom
    ) => Effect.Effect<BatchOutcome, PostboxReaderFailed>;
    readonly wire: Effect.Effect<OpenMailroom, PostboxReaderFailed>;
  }
>()("@mischief/worker/PostboxReader") {}

interface ReaderContext {
  readonly failure: PostboxReaderFailed | undefined;
  readonly mailroom: OpenMailroom | undefined;
  readonly outcome: BatchOutcome | undefined;
}

const wire = createEffectLogic({
  effect: () => PostboxReader.use((reader) => reader.wire),
});

const read = createEffectLogic({
  effect: ({ input }) => PostboxReader.use((reader) => reader.read(input)),
  schemas: { input: types<OpenMailroom>() },
});

export const postboxReaderMachine = setupEffect({
  actors: { read, wire },
  schemas: {
    context: types<ReaderContext>(),
  },
}).createMachine({
  context: { failure: undefined, mailroom: undefined, outcome: undefined },
  id: "postboxReader",
  initial: "turn",
  states: {
    failed: { type: "final" },
    read: { type: "final" },
    stalled: { type: "final" },
    turn: {
      initial: "wiring",
      onTimeout: { target: "stalled" },
      states: {
        reading: {
          invoke: {
            input: ({ context }) => {
              if (context.mailroom === undefined) {
                throw new Error(
                  "Postbox reader cannot read before this turn's wiring finishes"
                );
              }

              return context.mailroom;
            },
            onDone: ({ event }) => ({
              context: { outcome: event.output },
              target: "#postboxReader.read",
            }),
            onError: ({ event }) => ({
              context: { failure: event.error },
              target: "#postboxReader.failed",
            }),
            src: "read",
          },
        },
        wiring: {
          invoke: {
            onDone: ({ event }) => ({
              context: { mailroom: event.output },
              target: "reading",
            }),
            onError: ({ event }) => ({
              context: { failure: event.error },
              target: "#postboxReader.failed",
            }),
            src: "wire",
          },
        },
      },
      timeout: READ_DEADLINE_MS,
    },
  },
});

export type ReaderEnding = BatchOutcome | "failed" | "stalled";

const endingOf = (
  snapshot: SnapshotFrom<typeof postboxReaderMachine>
): ReaderEnding => {
  if (snapshot.matches("read")) {
    return snapshot.context.outcome ?? "idle";
  }

  return snapshot.matches("stalled") ? "stalled" : "failed";
};

const STALLED = `the Postbox reader made no progress in ${READ_DEADLINE_MS / 1000} s (twice the ${LONG_POLL_MS / 1000} s long-poll plus margin), so this alarm stopped it; the next alarm wires a fresh client. Next check: if this repeats, look in the celld journal for a lease acquire-attempt with no answer, then probe MISCHIEF_MAILBOX_URL from the celld host`;

export const readerTurn = Effect.fn("postboxReaderTurn")(
  function* postboxReaderTurn() {
    const actor = yield* createEffectActor(postboxReaderMachine);
    yield* watchActor("postboxReaderMachine", actor);

    const ended = yield* waitFor(
      actor,
      (snapshot) => snapshot.status === "done"
    );

    const { context } = ended;
    const ending = endingOf(ended);

    if (ending === "stalled") {
      yield* Effect.logWarning(STALLED);
    }

    if (ending === "failed") {
      yield* Effect.logWarning(
        `the Postbox reader stopped (${context.failure?.kind ?? "Unavailable"}: ${context.failure?.reason ?? "no reason"}); the next alarm wires a fresh client`
      );
    }

    return ending;
  },
  Effect.scoped
);
