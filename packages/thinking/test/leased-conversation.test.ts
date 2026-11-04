import { expect, it } from "@effect/vitest";
import { Thinker } from "@mischief/core";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { constUndefined } from "effect/Function";
import { TestClock } from "effect/testing";

import { piThinker } from "../dist/index.js";
import { callsOf, fauxWorld, temporaryWorld } from "./faux-world.js";

it.effect.prop(
  "a detached think reattaches to its original model task without aborting it; an explicit leased-work abort reaches the conversation and permits a fresh submission",
  { deliberate: Schema.Boolean },
  ({ deliberate }) =>
    Effect.gen(function* leasedConversation() {
      const dir = temporaryWorld();
      const started = yield* Deferred.make<boolean>();
      const complete = yield* Deferred.make<boolean>();
      const observed = { aborted: 0 };

      const options = fauxWorld(
        dir,
        false,
        () => {
          Deferred.doneUnsafe(started, Effect.succeed(true));
        },
        constUndefined,
        {
          aborted: () => {
            observed.aborted += 1;
          },
          complete: Deferred.await(complete).pipe(Effect.asVoid),
        }
      );

      yield* Effect.gen(function* attachedWork() {
        const thinker = yield* Thinker;

        const call = {
          agent: { model: "sol" },
          ceiling: "high",
          epoch: 0,
          key: "draft",
          prompt: "leased work",
          runId: "leased",
          visit: 1,
        } satisfies Parameters<Thinker["Service"]["think"]>[0];

        const first = yield* thinker.think(call).pipe(Effect.forkChild);

        yield* Deferred.await(started);
        yield* Fiber.interrupt(first);
        expect(observed.aborted).toBe(0);
        expect(callsOf(dir)).toHaveLength(1);

        if (deliberate) {
          yield* (
            thinker.abort?.(call) ??
              Effect.die("pi-thinker must wire abort for leased work")
          );
          expect(observed.aborted).toBe(1);
        }

        const resumed = yield* thinker.think(call).pipe(Effect.forkChild);

        yield* Deferred.succeed(complete, true);
        const thought = yield* Fiber.join(resumed);

        expect(callsOf(dir)).toHaveLength(deliberate ? 2 : 1);
        expect(thought.output).toBe("answer:leased work:1");
        expect(observed.aborted).toBe(deliberate ? 1 : 0);
      }).pipe(Effect.provide(piThinker(options)));
    }).pipe(Effect.scoped, TestClock.withLive),
  { arbitrary: { runs: 6 }, timeout: 15_000 }
);
