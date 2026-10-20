import { expect, it } from "@effect/vitest";
import { createEffectActor, waitFor } from "@xstate/effect";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";
import { createMachine } from "xstate";

it.effect.prop(
  "restored bridge timers retain their deadline on the Effect clock and actors serialize by address",
  {
    duration: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 2 }))
    ),
  },
  ({ duration }) =>
    Effect.gen(function* restoreDeadline() {
      const machine = createMachine({
        id: "migration-clock",
        initial: "pending",
        states: {
          expired: { type: "final" },
          pending: { after: { [duration]: { target: "expired" } } },
        },
      });

      const actor = yield* createEffectActor(machine);
      expect(actor.toJSON()).toStrictEqual({
        $actor: actor.address,
      });
      yield* TestClock.adjust(duration - 1);
      expect(actor.getSnapshot().matches("pending")).toBe(true);
      const saved = structuredClone(actor.getPersistedSnapshot());
      actor.stop();
      yield* TestClock.adjust(2);
      const restored = yield* createEffectActor(machine, { snapshot: saved });

      const finished = yield* waitFor(restored, (snapshot) =>
        snapshot.matches("expired")
      ).pipe(Effect.orDie);

      expect(finished.value).toBe("expired");
    }),
  { arbitrary: { runs: 20 } }
);
