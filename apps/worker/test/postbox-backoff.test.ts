import { describe, expect, it } from "@effect/vitest";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { MailboxClientError } from "@rat-king/mailbox-client";
import {
  Cause,
  Clock,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Schema,
  Stream,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import { Mailroom } from "../src/mailroom-port.js";
import { waitForMail } from "../src/mailroom.js";
import { PostboxFailed } from "../src/postbox-failed.js";
import { readBatch } from "../src/postbox-inbox.js";
import type { Inbox } from "../src/postbox-inbox.js";
import { leaseBook } from "../src/postbox-lease.js";
import { PostboxReaderFailed } from "../src/postbox-reader-failed.js";
import { readerHost } from "../src/postbox-reader-host.js";
import { readerMarks } from "../src/postbox-reader-marks.js";
import { PostboxReader } from "../src/postbox-reader.js";

const empty = { events: [], throughSeq: 8 };

const layer = Layer.succeed(
  Mailroom,
  Mailroom.of({
    nameOf: () => Effect.die("unused"),
    seal: () => Effect.die("unused"),
    send: () => Effect.die("unused"),
    surface: () => Effect.void,
    tell: () => Effect.void,
  })
);

type Round =
  | "ended"
  | "quiet"
  | "wake"
  | "retry"
  | "acquire"
  | "page"
  | "watch";

const fakeReader = () => {
  const storage = nodeSqlStorage(":memory:");
  const leases = leaseBook(storage);
  const marks = readerMarks(storage);
  const opens: number[] = [];
  const resumes: boolean[] = [];
  let round: Round = "ended";
  let alarm = Option.none<number>();

  const failure = new PostboxFailed({
    reason: "the mailbox failed (SocketDisconnected): backup",
  });

  const inbox: Inbox = {
    acquire: (resume, expiresAt) =>
      Effect.suspend(() => {
        resumes.push(Option.isSome(resume));

        return round === "acquire"
          ? Effect.fail(failure)
          : Effect.succeed({
              did: "did:web:test.invalid",
              expiresAt,
              generation: 1,
              leaseId: "held",
            });
      }),
    page: () => (round === "page" ? Effect.fail(failure) : Effect.succeed([])),
    wait: (_held, _after, within) =>
      Effect.gen(function* openFakeWatch() {
        opens.push(yield* Clock.currentTimeMillis);

        if (round === "watch") {
          return yield* failure;
        }

        return yield* waitForMail((onRetry) => {
          if (round === "retry") {
            return Stream.fromEffect(
              onRetry(
                new MailboxClientError({
                  error: "SocketDisconnected",
                  reason: "backup",
                })
              )
            ).pipe(Stream.flatMap(() => Stream.fromEffect(Effect.never)));
          }

          if (round === "wake") {
            return Stream.make({
              events: [{ $type: "test#event", seq: 9 }],
              throughSeq: 9,
            });
          }

          return round === "quiet"
            ? Stream.concat(Stream.make(empty), Stream.fromEffect(Effect.never))
            : Stream.make(empty);
        }, within);
      }),
  };

  const reader = PostboxReader.of({
    wire: Effect.succeed({ head: Effect.succeed(8), inbox, layer }),
    read: (_mailroom, window) =>
      readBatch(
        inbox,
        {
          advance: () => {
            throw new Error("empty watches must not advance a cursor");
          },
          cursor: () => 0,
          leases,
          receive: () => Effect.die("empty watches must not receive or ack"),
        },
        window
      ).pipe(
        Effect.mapError((problem) =>
          PostboxReaderFailed.fromCause(Cause.fail(problem))
        )
      ),
  });

  const makeHost = () =>
    readerHost(
      {
        get: Effect.sync(() => alarm),
        set: (at) =>
          Effect.sync(() => {
            alarm = Option.some(at);
          }),
      },
      marks,
      {
        head: Effect.succeed({ cursor: 0, head: 0 }),
        notice: () => Effect.die("no mail waiting"),
      },
      () => reader
    );

  let host = makeHost();

  const fire = Effect.gen(function* fireAlarmWhenDue() {
    const now = yield* Clock.currentTimeMillis;
    const due = Option.getOrElse(alarm, () => now);

    if (due > now) {
      yield* TestClock.setTime(Math.ceil(due));
    }

    return yield* host.alarm;
  });

  return {
    alarm: () => Option.getOrThrow(alarm),
    fire,
    marks,
    opens,
    resumes,
    plan: (next: Round) => {
      round = next;
    },
    restart: () => {
      host = makeHost();
    },
    start: host.start,
  };
};

describe("Postbox durable reconnect backoff", () => {
  it.effect(
    "marks created before backoff retain their values and migrate to durable retry attempts",
    () =>
      Effect.gen(function* migrateLegacyMarks() {
        const storage = nodeSqlStorage(":memory:");
        storage.sql.exec(
          "CREATE TABLE postbox_reader_marks (id INTEGER PRIMARY KEY, last_read_at INTEGER NOT NULL, empty_turns INTEGER NOT NULL, noticed INTEGER NOT NULL)"
        );
        storage.sql.exec(
          "INSERT INTO postbox_reader_marks VALUES (1, 1234, 2, 1)"
        );
        const marks = readerMarks(storage);
        expect(Option.getOrThrow(yield* marks.get)).toStrictEqual({
          emptyTurns: 2,
          lastReadAt: 1234,
          noticed: true,
        });
        yield* marks.set({
          emptyTurns: 0,
          lastReadAt: 1234,
          noticed: true,
          retryAttempts: 4,
        });
        expect(
          Option.getOrThrow(yield* readerMarks(storage).get).retryAttempts
        ).toBe(4);
      })
  );
  it.effect(
    "100 immediate empty EOFs have bounded watch opens, survive host reconstruction and warn once",
    () =>
      Effect.gen(function* boundEmptyWatches() {
        const fake = fakeReader();
        const warnings: string[] = [];
        yield* fake.start;
        yield* Effect.gen(function* reconnectRepeatedly() {
          for (const index of Array.from({ length: 100 }, (_, n) => n)) {
            expect(yield* fake.fire).toBe("ended");
            const now = yield* Clock.currentTimeMillis;
            const ceiling = Math.min(20_000, 1000 * 2 ** Math.min(index, 7));
            expect(fake.alarm() - now).toBeGreaterThanOrEqual(ceiling * 0.8);
            expect(fake.alarm() - now).toBeLessThanOrEqual(ceiling);
            fake.restart();
          }
        }).pipe(
          Effect.provide(
            Logger.layer([
              Logger.formatSimple.pipe(
                Logger.map((line) => warnings.push(line))
              ),
            ])
          )
        );
        expect(fake.opens).toHaveLength(100);
        expect((fake.opens.at(-1) ?? 0) - (fake.opens[0] ?? 0)).toBeGreaterThan(
          1_500_000
        );
        expect(
          warnings.filter((line) => line.includes("backoff started"))
        ).toHaveLength(1);
        expect(warnings[0]).toContain("mischief/worker");
        expect(warnings[0]).toContain("ended before its window");
      }).pipe(Effect.scoped)
  );

  it.effect(
    "normal empty catch-up timeouts keep the 20 s then 60 s cadence without retry backoff",
    () =>
      Effect.gen(function* preserveTimeoutCadence() {
        const fake = fakeReader();
        fake.plan("quiet");
        yield* fake.start;

        for (const window of [20_000, 20_000, 20_000, 60_000]) {
          const fiber = yield* fake.fire.pipe(Effect.forkChild);
          yield* TestClock.adjust(window - 1);
          expect(fiber.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust(1);
          expect(yield* Fiber.join(fiber)).toBe("idle");
          expect(
            Option.getOrThrow(yield* fake.marks.get).retryAttempts ?? 0
          ).toBe(0);
        }

        expect(fake.opens).toStrictEqual([0, 20_000, 40_000, 60_000]);
      }).pipe(Effect.scoped)
  );

  it.effect.prop(
    "one disconnect, repeated empty reconnects, then a surviving watch settle quietly; a real wake resets the next retry",
    {
      reconnects: Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 }))
      ),
    },
    ({ reconnects }) =>
      Effect.gen(function* recoverAfterDisconnect() {
        const fake = fakeReader();
        yield* fake.start;
        fake.plan("retry");
        expect(yield* fake.fire).toBe("failed");
        fake.plan("ended");

        for (const _ of Array.from({ length: reconnects })) {
          expect(yield* fake.fire).toBe("ended");
        }

        const due = fake.alarm();
        fake.plan("quiet");
        yield* TestClock.setTime(Math.ceil(due));
        const fiber = yield* fake.fire.pipe(Effect.forkChild);
        yield* TestClock.adjust(20_000);
        expect(yield* Fiber.join(fiber)).toBe("idle");
        fake.plan("ended");
        expect(yield* fake.fire).toBe("ended");
        fake.plan("wake");
        expect(yield* fake.fire).toBe("more");
        fake.plan("ended");
        expect(yield* fake.fire).toBe("ended");
        const delay = fake.alarm() - (yield* Clock.currentTimeMillis);
        expect(delay).toBeGreaterThanOrEqual(800);
        expect(delay).toBeLessThanOrEqual(1000);
      }).pipe(Effect.scoped),
    { arbitrary: { runs: 100 } }
  );

  it.effect(
    "acquire, page and watch failures share exponential alarm backoff and transient failures preserve the resumable lease",
    () =>
      Effect.gen(function* boundFailedCalls() {
        const fake = fakeReader();
        yield* fake.start;
        expect(yield* fake.fire).toBe("ended");

        for (const kind of ["acquire", "page", "watch"] as const) {
          fake.plan(kind);
          expect(yield* fake.fire).toBe("failed");
          expect(
            fake.alarm() - (yield* Clock.currentTimeMillis)
          ).toBeGreaterThanOrEqual(1600);
        }

        expect(fake.resumes).toStrictEqual([false, true, true, true]);
      }).pipe(Effect.scoped)
  );
});
