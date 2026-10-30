import { watchActor } from "@mischief/capability/actor-watch";
import type { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import type { Completion } from "@mischief/model-bridge/protocol";
import {
  createEffectActor,
  createEffectLogic,
  snapshots,
  setupEffect,
} from "@xstate/effect";
import { Effect, Option, Stream } from "effect";
import type { Result } from "effect";
import { types } from "xstate";

import { WorkspaceRequestSchema, refusal } from "./protocol.js";
import type { WorkspaceRequest } from "./protocol.js";
import { Sandbox } from "./sandbox.js";

export const DEADLINE_MS = 15 * 60 * 1000;

const execute = createEffectLogic({
  effect: ({ input }) =>
    Sandbox.use(({ run }) => run(input)).pipe(
      Effect.timeoutOrElse({
        duration: DEADLINE_MS,
        orElse: () =>
          Effect.fail(
            refusal(
              "Workspace call exceeded its 15 minute deadline and was interrupted. Inspect workspace receipts and provider health, then resume the run.",
              504
            )
          ),
      }),
      Effect.result
    ),
  schemas: { input: WorkspaceRequestSchema },
});

interface CallContext {
  readonly outcome: Result.Result<Completion, BridgeFailure> | undefined;
  readonly request: WorkspaceRequest;
}

export const callMachine = setupEffect({
  actors: { execute },
  schemas: { context: types<CallContext>(), input: WorkspaceRequestSchema },
}).createMachine({
  context: ({ input }) => ({ outcome: undefined, request: input }),
  initial: "running",
  output: ({ context }) => context.outcome,
  states: {
    running: {
      invoke: {
        input: ({ context }) => context.request,
        onDone: {
          context: ({ context, event }) => ({
            ...context,
            outcome: event.output,
          }),
          target: "settled",
        },
        src: "execute",
      },
    },
    settled: { type: "final" },
  },
});

export const runCall = Effect.fn("WorkspaceBridge.runCall")(function* runCall(
  request: WorkspaceRequest
) {
  const actor = yield* createEffectActor(callMachine, { input: request });
  yield* watchActor("workspaceCall", actor);

  const settled = yield* snapshots(actor).pipe(
    Stream.filter(
      (snapshot) => snapshot.status === "done" || snapshot.status === "error"
    ),
    Stream.runHead
  );

  const outcome =
    Option.isSome(settled) && settled.value.status === "done"
      ? settled.value.output
      : undefined;

  if (outcome === undefined) {
    return yield* Effect.die("Workspace call settled without an outcome");
  }

  return yield* Effect.fromResult(outcome);
}, Effect.scoped);
