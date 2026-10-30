import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import type { Completion } from "@mischief/model-bridge/protocol";
import { Clock, Context, Effect, Layer, Option, Ref, Semaphore } from "effect";

import { runCall } from "./call-machine.js";
import { refusal } from "./protocol.js";
import type { WorkspaceRequest } from "./protocol.js";
import { Sandbox } from "./sandbox.js";

export const MAX_IN_FLIGHT = 8;

export const DOWNTIME_START = Date.parse("2026-11-04T02:30:00Z");

export const DOWNTIME_END = Date.parse("2026-11-04T16:30:00Z");

export class Bridge extends Context.Service<
  Bridge,
  {
    readonly inFlight: Effect.Effect<number>;
    readonly run: (
      request: WorkspaceRequest
    ) => Effect.Effect<Completion, BridgeFailure>;
  }
>()("@mischief/workspace-bridge/Bridge") {
  static readonly layer = Layer.effect(
    Bridge,
    Effect.gen(function* makeBridge() {
      const sandbox = yield* Sandbox;
      const slots = yield* Semaphore.make(MAX_IN_FLIGHT);
      const inFlight = yield* Ref.make(0);

      const run = Effect.fn("WorkspaceBridge.run")(function* run(
        request: WorkspaceRequest
      ) {
        const now = yield* Clock.currentTimeMillis;

        if (now >= DOWNTIME_START && now < DOWNTIME_END) {
          return yield* refusal(
            "Workspace host is in its scheduled downtime until 2026-11-04T16:30:00Z. Park this think and retry after that time; the bridge does not queue calls.",
            503
          );
        }

        const result = yield* slots.withPermitsIfAvailable(1)(
          Effect.acquireUseRelease(
            Ref.update(inFlight, (count) => count + 1),
            () =>
              runCall(request).pipe(Effect.provideService(Sandbox, sandbox)),
            () => Ref.update(inFlight, (count) => count - 1)
          )
        );

        return yield* Option.match(result, {
          onNone: () =>
            Effect.fail(
              new BridgeFailure({
                message:
                  "All eight workspace sandboxes are busy. Park this think and retry after retry-after; the bridge does not queue calls.",
                retryAfter: 30,
                status: 503,
              })
            ),
          onSome: Effect.succeed,
        });
      });

      return Bridge.of({ inFlight: Ref.get(inFlight), run });
    })
  );
}
