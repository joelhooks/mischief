import { watchActor } from "@mischief/capability/actor-watch";
import { createEffectActor, fromEffect, setupEffect } from "@xstate/effect";
import { Context, Effect } from "effect";
import { types } from "xstate";

import type { openMailroom } from "./mailroom.js";
import type { PostboxReaderFailed } from "./postbox-reader-failed.js";

export type OpenMailroom = Effect.Success<ReturnType<typeof openMailroom>>;

export class PostboxReader extends Context.Service<
  PostboxReader,
  {
    readonly consume: (
      mailroom: OpenMailroom
    ) => Effect.Effect<void, PostboxReaderFailed>;
    readonly wire: Effect.Effect<OpenMailroom, PostboxReaderFailed>;
  }
>()("@mischief/worker/PostboxReader") {}

interface ReaderContext {
  readonly afterWiring: "ready" | "consuming";
  readonly failure: PostboxReaderFailed | undefined;
  readonly mailroom: OpenMailroom | undefined;
}

const wire = fromEffect({
  effect: () => PostboxReader.use((reader) => reader.wire),
});

const consume = fromEffect({
  effect: ({ input }) => PostboxReader.use((reader) => reader.consume(input)),
  schemas: { input: types<OpenMailroom>() },
});

export const postboxReaderMachine = setupEffect({
  actors: { consume, wire },
  schemas: {
    context: types<ReaderContext>(),
  },
}).createMachine({
  context: { afterWiring: "ready", failure: undefined, mailroom: undefined },
  initial: "idle",
  on: { STOP: { target: ".stopped" } },
  states: {
    consuming: {
      invoke: {
        input: ({ context }) => {
          if (context.mailroom === undefined) {
            throw new Error(
              "Postbox reader cannot consume before wiring finishes"
            );
          }

          return context.mailroom;
        },
        onDone: { target: "retrying" },
        onError: ({ event }) => ({
          context: { failure: event.error },
          target:
            event.error.kind === "DatabaseMissing" ? "dbMissing" : "retrying",
        }),
        src: "consume",
      },
    },
    dbMissing: {
      on: {
        START: { context: { afterWiring: "ready" }, target: "resuming" },
        WATCHDOG: { context: { afterWiring: "consuming" }, target: "resuming" },
      },
    },
    idle: {
      on: {
        START: { target: "wiring" },
        WATCHDOG: { context: { afterWiring: "consuming" }, target: "wiring" },
      },
    },
    ready: {
      on: { WATCHDOG: { target: "consuming" } },
    },
    resuming: {
      always: ({ context }) => ({
        context: { failure: undefined },
        target: context.mailroom === undefined ? "wiring" : context.afterWiring,
      }),
    },
    retrying: {
      on: {
        START: { context: { afterWiring: "ready" }, target: "resuming" },
        WATCHDOG: { context: { afterWiring: "consuming" }, target: "resuming" },
      },
    },
    stopped: { type: "final" },
    wiring: {
      invoke: {
        onDone: ({ context, event }) => ({
          context: { mailroom: event.output },
          target: context.afterWiring,
        }),
        onError: ({ event }) => ({
          context: { failure: event.error },
          target:
            event.error.kind === "DatabaseMissing" ? "dbMissing" : "retrying",
        }),
        src: "wire",
      },
      on: { WATCHDOG: { context: { afterWiring: "consuming" } } },
    },
  },
});

export const startPostboxReader = Effect.fn("startPostboxReader")(
  function* startPostboxReader() {
    const actor = yield* createEffectActor(postboxReaderMachine);
    yield* watchActor("postboxReaderMachine", actor);

    return actor;
  }
);
