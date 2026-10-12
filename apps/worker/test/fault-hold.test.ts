import { expect, it } from "@effect/vitest";
import { Mail } from "@mischief/core";
import { Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import { faultHold, faultHoldSeconds } from "../src/fault-hold.js";

const CALL = { epoch: 0, key: "land", runId: "proof", visit: 1 };

const SEALED = { envelope: "{}", messageId: "proof/land#1" };

const recording = (sent: string[]) =>
  Layer.succeed(
    Mail,
    Mail.of({
      seal: () => Effect.succeed(SEALED),
      send: (_call, { messageId }) =>
        Effect.sync(() => {
          sent.push(messageId);
        }),
    })
  );

it.effect("an unset, empty or out-of-range hold is off", () =>
  Effect.sync(() => {
    expect(
      [undefined, "", "0", "601", "1.5", "ten"].map(faultHoldSeconds)
    ).toStrictEqual(Array.from({ length: 6 }, () => Option.none()));
    expect(faultHoldSeconds("150")).toStrictEqual(Option.some(150));
  })
);

it.effect("with the hold off, a send reaches the outbox at once", () =>
  Effect.gen(function* off() {
    const sent: string[] = [];

    yield* Mail.use((mail) => mail.send(CALL, SEALED)).pipe(
      Effect.provide(faultHold(Option.none())(recording(sent)))
    );

    expect(sent).toStrictEqual([SEALED.messageId]);
  })
);

it.effect(
  "with the hold on, a send reaches the outbox only after the hold",
  () =>
    Effect.gen(function* on() {
      const sent: string[] = [];

      const fiber = yield* Mail.use((mail) => mail.send(CALL, SEALED)).pipe(
        Effect.provide(faultHold(Option.some(150))(recording(sent))),
        Effect.forkChild
      );

      yield* TestClock.adjust("149 seconds");
      expect(sent).toStrictEqual([]);

      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect(sent).toStrictEqual([SEALED.messageId]);
    })
);
