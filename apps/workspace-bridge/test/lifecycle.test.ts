import { expect, it } from "@effect/vitest";
import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Deferred, Effect, Fiber, Ref, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import { Bridge } from "../src/bridge.js";
import { runCall, DEADLINE_MS } from "../src/call-machine.js";
import { Sandbox } from "../src/sandbox.js";
import { request, completion } from "./fixtures.js";

it.effect.prop(
  "generated bursts never start a ninth Pi and release every permit on success or failure",
  {
    fail: Arbitrary.schema(Schema.Boolean),
    width: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: 9 }))
    ),
  },
  ({ fail, width }) =>
    Effect.gen(function* burst() {
      const start = yield* Deferred.make<boolean>();
      const gate = yield* Deferred.make<boolean>();
      const active = yield* Ref.make(0);
      const peak = yield* Ref.make(0);
      const admitted = Math.min(8, width);

      const process = Sandbox.of({
        run: () =>
          Effect.acquireUseRelease(
            Ref.updateAndGet(active, (n) => n + 1).pipe(
              Effect.tap((n) => Ref.update(peak, (p) => Math.max(p, n))),
              Effect.tap((n) =>
                n === admitted ? Deferred.succeed(start, true) : Effect.void
              )
            ),
            () =>
              Deferred.await(gate).pipe(
                Effect.andThen(
                  fail
                    ? Effect.fail(
                        new BridgeFailure({ message: "upstream", status: 500 })
                      )
                    : Effect.succeed(completion)
                )
              ),
            () => Ref.update(active, (n) => n - 1)
          ),
        sweep: Effect.void,
      });

      yield* Effect.gen(function* sharedBridge() {
        const bridge = yield* Bridge;

        const fibers = yield* Effect.forEach(
          Array.from({ length: width }),
          () => Effect.forkChild(bridge.run(request).pipe(Effect.result))
        );

        yield* Deferred.await(start);
        expect(yield* bridge.inFlight).toBe(admitted);

        if (admitted === 8) {
          const ninth = yield* Effect.flip(bridge.run(request));
          expect(ninth.status).toBe(503);
          expect(ninth.retryAfter).toBeGreaterThan(0);
        }

        yield* Deferred.succeed(gate, true);

        const outcomes = yield* Effect.all(
          fibers.map((fiber) => Fiber.join(fiber))
        );

        expect(
          outcomes.filter((outcome) => Result.isSuccess(outcome))
        ).toHaveLength(fail ? 0 : admitted);
        expect(yield* Ref.get(peak)).toBe(admitted);
        expect(yield* bridge.inFlight).toBe(0);
        expect(yield* Ref.get(active)).toBe(0);
        const second = yield* bridge.run(request).pipe(Effect.result);
        expect(second._tag).toBe(fail ? "Failure" : "Success");
      }).pipe(
        Effect.provide(Bridge.layer),
        Effect.provideService(Sandbox, process)
      );
    })
);

it.effect(
  "the call deadline returns 504 after cleanup and before the outer think timeout",
  () =>
    Effect.gen(function* timedOut() {
      const started = yield* Deferred.make<boolean>();
      const released = yield* Ref.make(false);

      const fiber = yield* Effect.forkChild(
        runCall(request).pipe(
          Effect.result,
          Effect.provideService(
            Sandbox,
            Sandbox.of({
              run: () =>
                Effect.acquireUseRelease(
                  Deferred.succeed(started, true),
                  () => Effect.never,
                  () => Ref.set(released, true)
                ),
              sweep: Effect.void,
            })
          )
        )
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust(DEADLINE_MS - 1);
      expect(yield* Ref.get(released)).toBe(false);
      yield* TestClock.adjust(1);
      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Failure");

      if (Result.isFailure(result)) {
        expect(result.failure.status).toBe(504);
      }

      expect(yield* Ref.get(released)).toBe(true);
      expect(DEADLINE_MS).toBeLessThan(1_440_000);
    })
);

it.effect(
  "client cancellation releases the process before another call takes its slot",
  () =>
    Effect.gen(function* cancelled() {
      const start = yield* Deferred.make<boolean>();
      const closed = yield* Deferred.make<boolean>();
      const active = yield* Ref.make(0);

      const process = Sandbox.of({
        run: () =>
          Effect.acquireUseRelease(
            Ref.update(active, (n) => n + 1).pipe(
              Effect.andThen(Deferred.succeed(start, true))
            ),
            () => Effect.never,
            () =>
              Ref.update(active, (n) => n - 1).pipe(
                Effect.andThen(Deferred.succeed(closed, true))
              )
          ),
        sweep: Effect.void,
      });

      yield* Effect.gen(function* shared() {
        const bridge = yield* Bridge;
        const fiber = yield* Effect.forkChild(bridge.run(request));
        yield* Deferred.await(start);
        yield* Fiber.interrupt(fiber);
        yield* Deferred.await(closed);
        yield* Effect.yieldNow;
        expect(yield* bridge.inFlight).toBe(0);
        expect(yield* Ref.get(active)).toBe(0);
      }).pipe(
        Effect.provide(Bridge.layer),
        Effect.provideService(Sandbox, process)
      );
    })
);
