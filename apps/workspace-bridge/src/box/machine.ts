import { Effect, Schema } from "effect";
import { setup, transition, types } from "xstate";

import { refusal } from "../protocol.js";
import { State } from "./protocol.js";

export const boxMachine = setup({
  schemas: {
    context: types<Record<string, never>>(),
  },
}).createMachine({
  context: {},
  id: "box",
  initial: "absent",
  states: {
    absent: { on: { CREATE: { target: "idle" } } },
    destroyed: { on: { DESTROY: { target: "destroyed" } } },
    hibernated: {
      on: {
        CLONE: { target: "hibernated" },
        DESTROY: { target: "destroyed" },
        HIBERNATE: { target: "hibernated" },
        RESUME: { target: "idle" },
      },
    },
    idle: {
      on: {
        CLONE: { target: "idle" },
        DESTROY: { target: "destroyed" },
        HIBERNATE: { target: "hibernated" },
        PROMPT: { target: "running" },
        SUSPEND: { target: "suspended" },
      },
    },
    running: {
      on: { DONE: { target: "idle" }, LOST: { target: "suspended" } },
    },
    suspended: {
      on: {
        CLONE: { target: "suspended" },
        DESTROY: { target: "destroyed" },
        HIBERNATE: { target: "hibernated" },
        RESUME: { target: "idle" },
        SUSPEND: { target: "suspended" },
      },
    },
  },
});

export const nextState = Effect.fn("Box.nextState")(function* nextState(
  state: typeof State.Type,
  type: string
) {
  const before = boxMachine.resolveState({ context: {}, value: state });

  if (!before.can({ type })) {
    return yield* refusal(
      `Cannot ${type.toLowerCase()} a ${state} box; changing files while a prompt runs could corrupt its session. GET /v1/boxes/{id}, wait for idle or resume a sleeping box, then retry.`,
      409
    );
  }

  const [after] = transition(boxMachine, before, { type });

  return yield* Schema.decodeUnknownEffect(State)(after.value).pipe(
    Effect.orDie
  );
});
