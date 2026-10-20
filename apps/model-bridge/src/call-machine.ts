import { watchActor } from "@mischief/capability/actor-watch";
import {
  createEffectActor,
  fromEffect,
  join,
  setupEffect,
} from "@xstate/effect";
import type { Result } from "effect";
import { Effect } from "effect";
import { types } from "xstate";

import { BridgeFailure } from "./bridge-failure.js";
import { CALL_TIMEOUT_MS, PiProcess } from "./pi-process.js";
import { ResponsesRequestSchema } from "./protocol.js";
import type { Completion, ResponsesRequest } from "./protocol.js";

const review = fromEffect({
  effect: ({ input }) =>
    PiProcess.use(({ run }) => run(input)).pipe(
      Effect.timeoutOrElse({
        duration: CALL_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new BridgeFailure({
              message:
                "The Opus bridge exceeded its 1380 second call deadline. Check provider health, then resume the run.",
              status: 504,
            })
          ),
      }),
      Effect.result
    ),
  schemas: { input: ResponsesRequestSchema },
});

interface CallContext {
  readonly outcome: Result.Result<Completion, BridgeFailure> | undefined;
  readonly request: ResponsesRequest;
}

export const callMachine = setupEffect({
  actors: { review },
  schemas: { context: types<CallContext>(), input: ResponsesRequestSchema },
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
        src: "review",
      },
    },
    settled: { type: "final" },
  },
});

export const runCall = Effect.fn("Bridge.runCall")(function* runCall(
  request: ResponsesRequest
) {
  const actor = yield* createEffectActor(callMachine, { input: request });
  yield* watchActor("opusReview", actor);
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- join's machine failures are defects; expected subprocess failures are the typed result.
  const outcome = yield* join(actor).pipe(Effect.orDie);

  if (outcome === undefined) {
    return yield* Effect.die("Opus review settled without an outcome");
  }

  return yield* Effect.fromResult(outcome);
}, Effect.scoped);
