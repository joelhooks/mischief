import { describe, expect, it } from "@effect/vitest";
import { MailboxClientError } from "@rat-king/mailbox-client";
import type { Batch } from "@rat-king/mailbox-client";
import { Effect, Exit, Fiber, Option, Schedule, Stream } from "effect";
import { TestClock } from "effect/testing";

import { waitForMail } from "../src/mailroom.js";

const empty: Batch = { events: [], throughSeq: 8 };

const mail: Batch = {
  events: [{ $type: "test#event", seq: 9 }],
  throughSeq: 9,
};

const disconnected = new MailboxClientError({
  error: "SocketDisconnected",
  reason: "backup closed socket",
});

const quiet = Stream.fromEffect(Effect.never);

describe("Postbox mailbox watch boundary", () => {
  it.effect(
    "an auth catch-up with no events stays on the same watch until the normal timeout",
    () =>
      Effect.gen(function* keepQuietWatch() {
        for (const stream of [
          quiet,
          Stream.concat(Stream.make(empty), quiet),
        ]) {
          const fiber = yield* waitForMail(() => stream, 20_000).pipe(
            Effect.forkChild
          );

          yield* TestClock.adjust(19_999);
          expect(fiber.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust(1);
          expect(yield* Fiber.join(fiber)).toBe(false);
        }
      })
  );

  it.effect(
    "EOF with or without an empty catch-up is not an idle timeout",
    () =>
      Effect.gen(function* distinguishWatchEof() {
        for (const stream of [Stream.empty, Stream.make(empty)]) {
          expect(yield* waitForMail(() => stream, 20_000)).toBe("ended");
        }
      })
  );

  it.effect("only a batch carrying events wakes the reader", () =>
    Effect.gen(function* wakeForEventsOnly() {
      expect(
        yield* waitForMail(() => Stream.make(empty, empty, mail), 20_000)
      ).toBe(true);
    })
  );

  it.effect(
    "the reconnect observer hands off to the alarm instead of opening sockets on the client's 100 ms retry",
    () =>
      Effect.gen(function* delegateReconnectToAlarm() {
        let opens = 0;

        const fiber = yield* waitForMail(
          (onRetry) =>
            Stream.fromEffect(
              Effect.sync(() => {
                opens += 1;
              })
            ).pipe(
              Stream.flatMap(() => Stream.fail(disconnected)),
              Stream.tapError(onRetry),
              Stream.retry(Schedule.exponential("100 millis"))
            ),
          20_000
        ).pipe(Effect.exit, Effect.forkChild);

        yield* TestClock.adjust(20_000);
        const exit = yield* Fiber.join(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          Option.getOrUndefined(Exit.findErrorOption(exit))?.reason
        ).toContain("SocketDisconnected");
        expect(opens).toBe(1);
      })
  );
});
