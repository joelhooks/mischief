import { describe, expect, it } from "@effect/vitest";
import type { EffectActor } from "@xstate/effect";
import { createEffectActor, send, waitFor } from "@xstate/effect";
import { Cause, Deferred, Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import type { SnapshotFrom } from "xstate";
import { getPathsFromEvents, getShortestPaths } from "xstate/graph";

import { Mailroom } from "../src/mailroom-port.js";
import { PostboxFailed } from "../src/postbox-failed.js";
import { PostboxReaderFailed } from "../src/postbox-reader-failed.js";
import { PostboxReader, postboxReaderMachine } from "../src/postbox-reader.js";
import type { OpenMailroom } from "../src/postbox-reader.js";

const Command = Schema.Literals([
  "start",
  "watchdog",
  "wired",
  "wireFailed",
  "dbWireFailed",
  "consumed",
  "consumeFailed",
  "dbConsumeFailed",
  "stop",
  "probe",
]);

type ReaderCommand = typeof Command.Type;

type State =
  | "idle"
  | "wiring"
  | "consuming"
  | "ready"
  | "retrying"
  | "dbMissing"
  | "stopped";

interface Model {
  readonly readRequested: boolean;
  readonly hasMailroom: boolean;
  readonly state: State;
}

const commands = Arbitrary.array(Arbitrary.schema(Command), { maxLength: 40 });

const mailroom: OpenMailroom = {
  consume: () => Effect.never,
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
};

const unavailable = new PostboxReaderFailed({
  kind: "Unavailable",
  reason: "mailbox unavailable",
});

const dbMissing = PostboxReaderFailed.fromCause(
  Cause.die(new Error("SQL error: no db for Postbox:test"))
);

const initialModel: Model = {
  hasMailroom: false,
  readRequested: false,
  state: "idle",
};

const completedModel = (model: Model, command: ReaderCommand): Model => {
  const { state } = model;

  if (state === "wiring") {
    if (command === "wired") {
      return {
        ...model,
        hasMailroom: true,
        state: model.readRequested ? "consuming" : "ready",
      };
    }

    if (command === "wireFailed" || command === "dbWireFailed") {
      return {
        ...model,
        state: command === "dbWireFailed" ? "dbMissing" : "retrying",
      };
    }
  }

  if (
    state === "consuming" &&
    (command === "consumed" ||
      command === "consumeFailed" ||
      command === "dbConsumeFailed")
  ) {
    return {
      ...model,
      state: command === "dbConsumeFailed" ? "dbMissing" : "retrying",
    };
  }

  return model;
};

const nextModel = (model: Model, command: ReaderCommand): Model => {
  const { state, hasMailroom } = model;

  if (state === "stopped") {
    return model;
  }

  if (command === "stop") {
    return { ...model, state: "stopped" };
  }

  if (command === "watchdog" && state === "wiring") {
    return { ...model, readRequested: true };
  }

  if (command === "watchdog" && state === "ready") {
    return { ...model, state: "consuming" };
  }

  if (
    (command === "start" || command === "watchdog") &&
    (state === "idle" || state === "retrying" || state === "dbMissing")
  ) {
    const destination = command === "watchdog" ? "consuming" : "ready";

    return {
      ...model,
      readRequested: command === "watchdog",
      state: hasMailroom ? destination : "wiring",
    };
  }

  return completedModel(model, command);
};

const invocation = (state: "wiring" | "consuming") => {
  const invoked = postboxReaderMachine.states[state]?.invoke[0];

  if (invoked === undefined) {
    throw new Error(`Postbox ${state} must invoke its work`);
  }

  return invoked.id;
};

const events = () => ({
  consumeFailed: {
    actorId: invocation("consuming"),
    error: unavailable,
    type: "xstate.error.actor",
  },
  consumed: {
    actorId: invocation("consuming"),
    output: undefined,
    type: "xstate.done.actor",
  },
  dbConsumeFailed: {
    actorId: invocation("consuming"),
    error: dbMissing,
    type: "xstate.error.actor",
  },
  dbWireFailed: {
    actorId: invocation("wiring"),
    error: dbMissing,
    type: "xstate.error.actor",
  },
  probe: { type: "UNHANDLED" },
  start: { type: "START" },
  stop: { type: "STOP" },
  watchdog: { type: "WATCHDOG" },
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

const assertSnapshot = (
  snapshot: SnapshotFrom<typeof postboxReaderMachine>,
  model: Model
) => {
  expect(snapshot.value).toBe(model.state);
  expect(snapshot.status).toBe(model.state === "stopped" ? "done" : "active");
  expect(snapshot.context.mailroom !== undefined).toBe(model.hasMailroom);

  if (model.state === "dbMissing") {
    expect(Schema.is(PostboxReaderFailed)(snapshot.context.failure)).toBe(true);
    expect(snapshot.context.failure?.kind).toBe("DatabaseMissing");
  }
};

const replayGraph = (generated: readonly ReaderCommand[]) => {
  const eventFor = events();
  const terminal = generated.indexOf("stop");

  const history =
    terminal === -1 ? generated : generated.slice(0, terminal + 1);

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

const commandEvent = (command: ReaderCommand) => {
  if (command === "start") {
    return { type: "START" };
  }

  if (command === "watchdog") {
    return { type: "WATCHDOG" };
  }

  if (command === "stop") {
    return { type: "STOP" };
  }

  return { type: "UNHANDLED" };
};

const performCommand = Effect.fn("performReaderCommand")(
  function* performReaderCommand(
    actor: EffectActor<typeof postboxReaderMachine>,
    state: State,
    command: ReaderCommand,
    wire: Deferred.Deferred<OpenMailroom, PostboxReaderFailed> | undefined,
    consumer: Deferred.Deferred<boolean, PostboxReaderFailed> | undefined
  ) {
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

    if (state === "consuming" && consumer !== undefined) {
      if (command === "consumed") {
        return yield* Deferred.succeed(consumer, true);
      }

      if (command === "consumeFailed" || command === "dbConsumeFailed") {
        return yield* Deferred.fail(
          consumer,
          command === "dbConsumeFailed" ? dbMissing : unavailable
        );
      }
    }

    return yield* send(actor, commandEvent(command));
  }
);

const replayActor = Effect.fn("replayPostboxReader")(
  function* replayPostboxReader(generated: readonly ReaderCommand[]) {
    const wires: Deferred.Deferred<OpenMailroom, PostboxReaderFailed>[] = [];
    const consumers: Deferred.Deferred<boolean, PostboxReaderFailed>[] = [];
    let wiring = 0;
    let consuming = 0;
    let maximumOwners = 0;

    const operations = PostboxReader.of({
      consume: (opened) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            expect(opened).toBe(mailroom);
            consuming += 1;
            maximumOwners = Math.max(maximumOwners, consuming);

            const result = Deferred.makeUnsafe<boolean, PostboxReaderFailed>();

            consumers.push(result);

            return result;
          }),
          (result) => Deferred.await(result).pipe(Effect.asVoid),
          () =>
            Effect.sync(() => {
              consuming -= 1;
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
    });

    const actor = yield* createEffectActor(postboxReaderMachine).pipe(
      Effect.provideService(PostboxReader, operations)
    );

    let model = initialModel;
    yield* waitFor(actor, (snapshot) => snapshot.matches("idle"));

    for (const command of [
      ...generated,
      "stop",
    ] satisfies readonly ReaderCommand[]) {
      const before = model;
      model = nextModel(model, command);
      yield* performCommand(
        actor,
        before.state,
        command,
        wires.at(-1),
        consumers.at(-1)
      );
      const expectedState = model.state;

      if (before.state !== model.state) {
        yield* waitFor(actor, (snapshot) => snapshot.value === expectedState);
      }

      yield* Effect.yieldNow;
      assertSnapshot(actor.getSnapshot(), model);
      expect(
        maximumOwners,
        "ownership is never duplicated"
      ).toBeLessThanOrEqual(1);
      expect(consuming, "only fully wired readers own consumption").toBe(
        model.state === "consuming" ? 1 : 0
      );
      expect(wiring).toBe(model.state === "wiring" ? 1 : 0);
    }

    const started = { consumers: consumers.length, wires: wires.length };
    yield* send(actor, { type: "WATCHDOG" });
    yield* send(actor, { type: "START" });
    yield* Effect.yieldNow;
    expect({ consumers: consumers.length, wires: wires.length }).toStrictEqual(
      started
    );
    expect(consuming + wiring).toBe(0);
  },
  Effect.scoped
);

describe("Postbox reader ownership", () => {
  it.prop(
    "typed mailroom failures preserve the caller's refusal reason",
    { reason: Schema.String },
    ({ reason }) => {
      const failure = PostboxReaderFailed.fromCause(
        Cause.fail(new PostboxFailed({ reason }))
      );

      expect(failure.reason).toBe(reason);
      expect(Schema.is(PostboxReaderFailed)(failure)).toBe(true);
    }
  );

  it.prop(
    "graph histories follow an independent ownership model",
    { generated: commands },
    ({ generated }) => {
      replayGraph(generated);
    },
    { arbitrary: { runs: 200 } }
  );

  it.effect.prop(
    "real actor serializes wiring, consumption, retries and stop",
    { generated: commands },
    ({ generated }) =>
      Effect.gen(function* replayFromIdleAndConsuming() {
        yield* replayActor(["watchdog", "wired", ...generated]);
        yield* replayActor(generated);
      }),
    { arbitrary: { runs: 200 } }
  );

  it.effect("shortest paths reach every stable state and stop from each", () =>
    Effect.gen(function* coverStableStates() {
      const eventFor = events();

      const paths = getShortestPaths(postboxReaderMachine, {
        events: (snapshot) => {
          if (snapshot.matches("wiring")) {
            return [
              eventFor.stop,
              eventFor.wired,
              eventFor.wireFailed,
              eventFor.dbWireFailed,
            ];
          }

          if (snapshot.matches("consuming")) {
            return [
              eventFor.stop,
              eventFor.consumed,
              eventFor.consumeFailed,
              eventFor.dbConsumeFailed,
            ];
          }

          return [eventFor.start, eventFor.watchdog, eventFor.stop];
        },
        serializeState: (snapshot) =>
          `${snapshot.value}:${snapshot.context.mailroom !== undefined}:${snapshot.context.afterWiring}`,
      });

      expect(new Set(paths.map((path) => path.state.value))).toStrictEqual(
        new Set([
          "idle",
          "wiring",
          "consuming",
          "ready",
          "dbMissing",
          "retrying",
          "stopped",
        ])
      );

      for (const path of paths) {
        const history = path.steps.slice(1).map((step): ReaderCommand => {
          const found = Object.entries(eventFor).find(
            ([, event]) => JSON.stringify(event) === JSON.stringify(step.event)
          );

          return Schema.decodeUnknownSync(Command)(found?.[0]);
        });

        replayGraph([...history, "stop"]);
        yield* replayActor([...history, "stop"]);
      }
    })
  );

  it.effect(
    "db-missing failures remain typed and recover on the next watchdog",
    () =>
      Effect.gen(function* recoverDatabase() {
        for (const history of [
          ["watchdog", "dbWireFailed", "watchdog", "wired"],
          ["watchdog", "wired", "dbConsumeFailed", "watchdog"],
        ] satisfies ReaderCommand[][]) {
          replayGraph(history);
          yield* replayActor(history);
        }
      })
  );
});
