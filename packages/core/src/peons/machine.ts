import { Schema } from "effect";
import { createMachine, transition } from "xstate";

import { PeonState } from "./schema.js";

export const PeonEvent = Schema.Literals([
  "SPAWN",
  "PROMPT",
  "TURN_DONE",
  "IDLE_TIMEOUT",
  "SUSPEND",
  "HIBERNATE",
  "RESUME",
  "CLONE",
  "DESTROY",
  "BOX_LOST",
]);

export const peonMachine = createMachine({
  context: {},
  id: "peon",
  initial: "spawned",
  states: {
    attaching: {
      on: { BOX_LOST: { target: "suspended" }, TURN_DONE: { target: "idle" } },
    },
    destroyed: { type: "final" },
    hibernated: {
      on: {
        BOX_LOST: { target: "suspended" },
        CLONE: { target: "hibernated" },
        DESTROY: { target: "destroyed" },
        RESUME: { target: "attaching" },
      },
    },
    idle: {
      on: {
        BOX_LOST: { target: "suspended" },
        CLONE: { target: "idle" },
        DESTROY: { target: "destroyed" },
        HIBERNATE: { target: "hibernated" },
        IDLE_TIMEOUT: { target: "suspended" },
        PROMPT: { target: "running" },
        SUSPEND: { target: "suspended" },
      },
    },
    running: {
      on: { BOX_LOST: { target: "suspended" }, TURN_DONE: { target: "idle" } },
    },
    spawned: {
      on: { CLONE: { target: "suspended" }, SPAWN: { target: "attaching" } },
    },
    suspended: {
      on: {
        BOX_LOST: { target: "suspended" },
        CLONE: { target: "suspended" },
        DESTROY: { target: "destroyed" },
        HIBERNATE: { target: "hibernated" },
        RESUME: { target: "attaching" },
      },
    },
  },
});

export const peonTransition = (
  state: typeof PeonState.Type,
  event: typeof PeonEvent.Type
) => {
  const snapshot = peonMachine.resolveState({ context: {}, value: state });
  const [next] = transition(peonMachine, snapshot, { type: event });

  return Schema.decodeUnknownSync(PeonState)(next.value);
};

export const peonIdleAlarm = (
  state: typeof PeonState.Type,
  idleAt: number,
  template: { readonly suspendAfter: number; readonly hibernateAfter: number }
) => {
  if (state === "idle") {
    return idleAt + template.suspendAfter;
  }

  if (state === "suspended") {
    return idleAt + template.hibernateAfter;
  }

  return null;
};
