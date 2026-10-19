import { Context, Effect, Layer, Option, Ref, Semaphore } from "effect";

import { BridgeFailure } from "./bridge-failure.js";
import { runCall } from "./call-machine.js";
import { PiProcess } from "./pi-process.js";
import type { Completion, ResponsesRequest } from "./protocol.js";

export const MAX_IN_FLIGHT = 4;

export const BRIDGE_VERSION = "0.1.0";

export class Bridge extends Context.Service<
  Bridge,
  {
    readonly inFlight: Effect.Effect<number>;
    readonly run: (
      request: ResponsesRequest
    ) => Effect.Effect<Completion, BridgeFailure>;
  }
>()("@mischief/model-bridge/Bridge") {
  static readonly layer = Layer.effect(
    Bridge,
    Effect.gen(function* makeBridge() {
      const process = yield* PiProcess;
      const slots = yield* Semaphore.make(MAX_IN_FLIGHT);
      const inFlight = yield* Ref.make(0);

      const guarded = (request: ResponsesRequest) =>
        Effect.gen(function* admitted() {
          const outcome = yield* slots.withPermitsIfAvailable(1)(
            Effect.acquireUseRelease(
              Ref.update(inFlight, (n) => n + 1),
              () => process.run(request),
              () => Ref.update(inFlight, (n) => n - 1)
            )
          );

          return yield* Option.match(outcome, {
            onNone: () =>
              Effect.fail(
                new BridgeFailure({
                  message:
                    "All four Opus bridge slots are busy. Hold this step and resume after retry-after.",
                  retryAfter: 30,
                  status: 429,
                })
              ),
            onSome: Effect.succeed,
          });
        });

      return Bridge.of({
        inFlight: Ref.get(inFlight),
        run: (request) =>
          runCall(request).pipe(
            Effect.provideService(PiProcess, PiProcess.of({ run: guarded }))
          ),
      });
    })
  );
}
