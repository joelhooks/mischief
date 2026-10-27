import { describe, expect, it } from "@effect/vitest";
import type { EffectActor } from "@xstate/effect";
import { createEffectActor, send, waitFor } from "@xstate/effect";
import { Cause, Deferred, Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";
import type { SnapshotFrom } from "xstate";
import { getPathsFromEvents, getShortestPaths } from "xstate/graph";

import { Mailroom } from "../src/mailroom-port.js";
import { PostboxFailed } from "../src/postbox-failed.js";
import type { BatchOutcome } from "../src/postbox-inbox.js";
import { PostboxReaderFailed } from "../src/postbox-reader-failed.js";
import {
  PostboxReader,
  postboxReaderMachine,
  READ_DEADLINE_MS,
} from "../src/postbox-reader.js";
import type { OpenMailroom } from "../src/postbox-reader.js";

const Command = Schema.Literals([
  "wired",
  "wireFailed",
  "dbWireFailed",
  "readMore",
  "readIdle",
  "readFailed",
  "dbReadFailed",
  "deadline",
  "probe",
]);

type ReaderCommand = typeof Command.Type;

type State = "wiring" | "reading" | "read" | "failed" | "stalled";

interface Model {
  readonly failure: PostboxReaderFailed["kind"] | undefined;
  readonly hasMailroom: boolean;
  readonly outcome: BatchOutcome | undefined;
  readonly state: State;
}

const commands = Arbitrary.array(Arbitrary.schema(Command), { maxLength: 20 });

const opened = (): OpenMailroom => ({
  inbox: {
    acquire: () => Effect.die("unused"),
    page: () => Effect.die("unused"),
    wait: () => Effect.die("unused"),
  },
  layer: Layer.succeed(
    Mailroom,
    Mailroom.of({
      nameOf: () => Effect.die("unused"),
      seal: () => Effect.die("unused"),
      send: () => Effect.die("unused"),
      surface: () => Effect.void,
      tell: () => Effect.void,
    })
  ),
});

const mailroom = opened();

const unavailable = new PostboxReaderFailed({
  kind: "Unavailable",
  reason: "mailbox unavailable",
});

const dbMissing = PostboxReaderFailed.fromCause(
  Cause.die(new Error("SQL error: no db for Postbox:test"))
);

const initialModel: Model = {
  failure: undefined,
  hasMailroom: false,
  outcome: undefined,
  state: "wiring",
};

const finals = new Set<State>(["read", "failed", "stalled"]);

const failedWith = (
  model: Model,
  kind: PostboxReaderFailed["kind"]
): Model => ({ ...model, failure: kind, state: "failed" });

const nextModel = (model: Model, command: ReaderCommand): Model => {
  const { state } = model;

  if (finals.has(state)) {
    return model;
  }

  if (command === "deadline") {
    return { ...model, state: "stalled" };
  }

  if (state === "wiring") {
    if (command === "wired") {
      return { ...model, hasMailroom: true, state: "reading" };
    }

    if (command === "wireFailed") {
      return failedWith(model, "Unavailable");
    }

    if (command === "dbWireFailed") {
      return failedWith(model, "DatabaseMissing");
    }
  }

  if (state === "reading") {
    if (command === "readMore" || command === "readIdle") {
      return {
        ...model,
        outcome: command === "readMore" ? "more" : "idle",
        state: "read",
      };
    }

    if (command === "readFailed") {
      return failedWith(model, "Unavailable");
    }

    if (command === "dbReadFailed") {
      return failedWith(model, "DatabaseMissing");
    }
  }

  return model;
};

const invocation = (state: "wiring" | "reading") => {
  const invoked = postboxReaderMachine.states.turn?.states[state]?.invoke[0];

  if (invoked === undefined) {
    throw new Error(`Postbox ${state} must invoke its work`);
  }

  return invoked.id;
};

const events = () => ({
  dbReadFailed: {
    actorId: invocation("reading"),
    error: dbMissing,
    type: "xstate.error.actor",
  },
  dbWireFailed: {
    actorId: invocation("wiring"),
    error: dbMissing,
    type: "xstate.error.actor",
  },
  deadline: { stateId: "postboxReader.turn", type: "xstate.timeout.state" },
  probe: { type: "UNHANDLED" },
  readFailed: {
    actorId: invocation("reading"),
    error: unavailable,
    type: "xstate.error.actor",
  },
  readIdle: {
    actorId: invocation("reading"),
    output: "idle",
    type: "xstate.done.actor",
  },
  readMore: {
    actorId: invocation("reading"),
    output: "more",
    type: "xstate.done.actor",
  },
  wireFailed: {
    actorId: invocation("wiring"),
    error: unavailable,
    type: "xstate.error.actor",
  },
  wired: {
    actorId: invocation("wiring"),
    output: mailroom,
    type: "xstate.done.actor",
  },
});

const stateOf = (snapshot: SnapshotFrom<typeof postboxReaderMachine>) =>
  (["wiring", "reading"] as const).find((nested) =>
    snapshot.matches({ turn: nested })
  ) ?? snapshot.value;

const assertSnapshot = (
  snapshot: SnapshotFrom<typeof postboxReaderMachine>,
  model: Model
) => {
  expect(stateOf(snapshot)).toBe(model.state);
  expect(snapshot.status).toBe(finals.has(model.state) ? "done" : "active");
  expect(snapshot.context.mailroom !== undefined).toBe(model.hasMailroom);
  expect(snapshot.context.outcome).toBe(model.outcome);
  expect(snapshot.context.failure?.kind).toBe(model.failure);
};

const replayGraph = (history: readonly ReaderCommand[]) => {
  const eventFor = events();
  let graphModel = initialModel;

  const paths = getPathsFromEvents(
    postboxReaderMachine,
    history.map((command) => {
      const next = nextModel(graphModel, command);
      const event = next === graphModel ? eventFor.probe : eventFor[command];
      graphModel = next;

      return event;
    })
  );

  expect(paths).toHaveLength(1);
  let model = initialModel;

  for (const [index, step] of (paths[0]?.steps ?? []).entries()) {
    const command = history[index - 1];

    if (command !== undefined) {
      model = nextModel(model, command);
    }

    assertSnapshot(step.state, model);
  }
};

const performCommand = Effect.fn("performReaderCommand")(
  function* performReaderCommand(
    actor: EffectActor<typeof postboxReaderMachine>,
    state: State,
    command: ReaderCommand,
    wire: Deferred.Deferred<OpenMailroom, PostboxReaderFailed> | undefined,
    reader: Deferred.Deferred<BatchOutcome, PostboxReaderFailed> | undefined
  ) {
    if (command === "deadline") {
      return yield* TestClock.adjust(READ_DEADLINE_MS);
    }

    if (state === "wiring" && wire !== undefined) {
      if (command === "wired") {
        return yield* Deferred.succeed(wire, mailroom);
      }

      if (command === "wireFailed" || command === "dbWireFailed") {
        return yield* Deferred.fail(
          wire,
          command === "dbWireFailed" ? dbMissing : unavailable
        );
      }
    }

    if (state === "reading" && reader !== undefined) {
      if (command === "readMore" || command === "readIdle") {
        return yield* Deferred.succeed(
          reader,
          command === "readMore" ? "more" : "idle"
        );
      }

      if (command === "readFailed" || command === "dbReadFailed") {
        return yield* Deferred.fail(
          reader,
          command === "dbReadFailed" ? dbMissing : unavailable
        );
      }
    }

    return yield* send(actor, { type: "UNHANDLED" });
  }
);

const replayActor = Effect.fn("replayPostboxReader")(
  function* replayPostboxReader(history: readonly ReaderCommand[]) {
    const wires: Deferred.Deferred<OpenMailroom, PostboxReaderFailed>[] = [];
    const readers: Deferred.Deferred<BatchOutcome, PostboxReaderFailed>[] = [];
    let wiring = 0;
    let reading = 0;

    yield* Effect.scoped(
      Effect.gen(function* turn() {
        const actor = yield* createEffectActor(postboxReaderMachine).pipe(
          Effect.provideService(
            PostboxReader,
            PostboxReader.of({
              read: (given) =>
                Effect.acquireUseRelease(
                  Effect.sync(() => {
                    expect(given, "a turn reads only what it wired").toBe(
                      mailroom
                    );
                    reading += 1;

                    const result = Deferred.makeUnsafe<
                      BatchOutcome,
                      PostboxReaderFailed
                    >();

                    readers.push(result);

                    return result;
                  }),
                  Deferred.await,
                  () =>
                    Effect.sync(() => {
                      reading -= 1;
                    })
                ),
              wire: Effect.acquireUseRelease(
                Effect.sync(() => {
                  wiring += 1;

                  const result = Deferred.makeUnsafe<
                    OpenMailroom,
                    PostboxReaderFailed
                  >();

                  wires.push(result);

                  return result;
                }),
                Deferred.await,
                () =>
                  Effect.sync(() => {
                    wiring -= 1;
                  })
              ),
            })
          )
        );

        const started = (state: State) =>
          Effect.yieldNow.pipe(
            Effect.repeat({
              until: () =>
                wiring === (state === "wiring" ? 1 : 0) &&
                reading === (state === "reading" ? 1 : 0),
            })
          );

        let model = initialModel;

        for (const command of history) {
          const before = model;
          yield* started(before.state);
          model = nextModel(model, command);
          yield* performCommand(
            actor,
            before.state,
            command,
            wires.at(-1),
            readers.at(-1)
          );

          if (before.state !== model.state) {
            const expected = model.state;
            yield* waitFor(actor, (snapshot) => stateOf(snapshot) === expected);
          }

          yield* Effect.yieldNow;
          assertSnapshot(actor.getSnapshot(), model);
          expect(wires.length, "a turn wires once").toBeLessThanOrEqual(1);
          expect(readers.length, "a turn reads once").toBeLessThanOrEqual(1);
          expect(wiring, "wiring runs only while wiring").toBe(
            model.state === "wiring" ? 1 : 0
          );
          expect(reading, "a read runs only while reading").toBe(
            model.state === "reading" ? 1 : 0
          );
        }
      })
    );

    expect(wiring + reading, "closing the turn's scope stops its work").toBe(0);
  }
);

describe("Postbox reader turn", () => {
  it.prop(
    "typed mailroom failures preserve the caller's refusal reason",
    { reason: Schema.String },
    ({ reason }) => {
      const failure = PostboxReaderFailed.fromCause(
        Cause.fail(new PostboxFailed({ reason }))
      );

      expect(failure.reason).toBe(reason);
      expect(failure.kind).toBe(
        reason.includes("no db for Postbox:")
          ? "DatabaseMissing"
          : "Unavailable"
      );
    }
  );

  it.prop(
    "graph histories follow an independent turn model",
    { history: commands },
    ({ history }) => {
      replayGraph(history);
    },
    { arbitrary: { runs: 200 } }
  );

  it.effect.prop(
    "the real actor wires once, reads once, and its work stops at its ending or when its turn closes",
    { history: commands },
    ({ history }) => replayActor(history),
    { arbitrary: { runs: 200 } }
  );

  it.effect("shortest paths reach every ending", () =>
    Effect.gen(function* coverEndings() {
      const eventFor = events();

      const paths = getShortestPaths(postboxReaderMachine, {
        events: (snapshot) => {
          if (snapshot.matches({ turn: "wiring" })) {
            return [
              eventFor.wired,
              eventFor.wireFailed,
              eventFor.dbWireFailed,
              eventFor.deadline,
            ];
          }

          if (snapshot.matches({ turn: "reading" })) {
            return [
              eventFor.readMore,
              eventFor.readIdle,
              eventFor.readFailed,
              eventFor.dbReadFailed,
              eventFor.deadline,
            ];
          }

          return [];
        },
        serializeState: (snapshot) =>
          JSON.stringify([
            stateOf(snapshot),
            snapshot.context.outcome,
            snapshot.context.failure?.kind,
          ]),
      });

      expect(new Set(paths.map((path) => stateOf(path.state)))).toStrictEqual(
        new Set(["wiring", "reading", "read", "failed", "stalled"])
      );

      for (const path of paths) {
        const history = path.steps.slice(1).map((step): ReaderCommand => {
          const found = Object.entries(eventFor).find(
            ([, event]) => JSON.stringify(event) === JSON.stringify(step.event)
          );

          return Schema.decodeUnknownSync(Command)(found?.[0]);
        });

        replayGraph(history);
        yield* replayActor(history);
      }
    })
  );
});
