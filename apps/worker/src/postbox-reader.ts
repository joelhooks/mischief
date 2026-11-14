import { watchActor } from "@mischief/capability/actor-watch";
import {
  createEffectActor,
  createEffectLogic,
  setupEffect,
  waitFor,
} from "@xstate/effect";
import { Cause, Context, Effect, Option } from "effect";
import { types } from "xstate";
import type { SnapshotFrom } from "xstate";

import type { openMailroom } from "./mailroom.js";
import { LONG_POLL_MS } from "./postbox-inbox.js";
import type { BatchOutcome } from "./postbox-inbox.js";
import { PostboxReaderFailed } from "./postbox-reader-failed.js";

export type OpenMailroom = Effect.Success<ReturnType<typeof openMailroom>>;

export const deadlineFor = (window: number) => 2 * window + 5000;

export const READ_DEADLINE_MS = deadlineFor(LONG_POLL_MS);

export class PostboxReader extends Context.Service<
  PostboxReader,
  {
    readonly read: (
      mailroom: OpenMailroom,
      window: number
    ) => Effect.Effect<BatchOutcome, PostboxReaderFailed>;
    readonly wire: Effect.Effect<OpenMailroom, PostboxReaderFailed>;
  }
>()("@mischief/worker/PostboxReader") {}

interface ReaderContext {
  readonly failure: PostboxReaderFailed | undefined;
  readonly mailroom: OpenMailroom | undefined;
  readonly outcome: BatchOutcome | undefined;
  readonly window: number;
}

interface ReadInput {
  readonly mailroom: OpenMailroom;
  readonly window: number;
}

const wire = createEffectLogic({
  effect: () => PostboxReader.use((reader) => reader.wire),
});

const read = createEffectLogic({
  effect: ({ input }) =>
    PostboxReader.use((reader) => reader.read(input.mailroom, input.window)),
  schemas: { input: types<ReadInput>() },
});

export const postboxReaderMachine = setupEffect({
  actors: { read, wire },
  schemas: {
    context: types<ReaderContext>(),
    input: types<{ readonly window: number }>(),
  },
}).createMachine({
  context: ({ input }) => ({
    failure: undefined,
    mailroom: undefined,
    outcome: undefined,
    window: input.window,
  }),
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

              return { mailroom: context.mailroom, window: context.window };
            },
            onDone: ({ event }) => ({
              context: { outcome: event.output },
              target: "#postboxReader.read",
            }),
            onError: ({ event }) => ({
              context: {
                failure: Option.getOrElse(
                  Cause.findErrorOption(event.error.cause),
                  () => PostboxReaderFailed.fromCause(event.error.cause)
                ),
              },
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
              context: {
                failure: Option.getOrElse(
                  Cause.findErrorOption(event.error.cause),
                  () => PostboxReaderFailed.fromCause(event.error.cause)
                ),
              },
              target: "#postboxReader.failed",
            }),
            src: "wire",
          },
        },
      },
      timeout: ({ context }) => deadlineFor(context.window),
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

const stalled = (window: number) =>
  `the Postbox reader made no progress in ${deadlineFor(window) / 1000} s (twice the ${window / 1000} s long-poll plus margin), so this alarm stopped it; the next alarm wires a fresh client. Next check: if this repeats, look in the celld journal for a lease acquire-attempt with no answer, then probe MISCHIEF_MAILBOX_URL from the celld host`;

export interface TurnReport {
  readonly ending: ReaderEnding;
  readonly problem: string;
}

export const readerTurn = Effect.fn("postboxReaderTurn")(
  function* postboxReaderTurn(window: number) {
    const actor = yield* createEffectActor(postboxReaderMachine, {
      input: { window },
    });

    yield* watchActor("postboxReaderMachine", actor);

    const ended = yield* waitFor(
      actor,
      (snapshot) => snapshot.status === "done"
    );

    const { context } = ended;
    const ending = endingOf(ended);

    if (ending === "stalled") {
      const problem = stalled(window);
      yield* Effect.logWarning(problem);

      return { ending, problem } satisfies TurnReport;
    }

    if (ending === "failed") {
      const problem = `the Postbox reader stopped (${context.failure?.kind ?? "Unavailable"}: ${context.failure?.reason ?? "no reason"}); the next alarm wires a fresh client`;
      yield* Effect.logWarning(problem);

      return { ending, problem } satisfies TurnReport;
    }

    return { ending, problem: "" } satisfies TurnReport;
  },
  Effect.scoped
);
