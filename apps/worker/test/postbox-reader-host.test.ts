import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Clock,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import { Mailroom } from "../src/mailroom-port.js";
import { LONG_POLL_MS } from "../src/postbox-inbox.js";
import { PostboxReaderFailed } from "../src/postbox-reader-failed.js";
import { readerHost } from "../src/postbox-reader-host.js";
import { PostboxReader, READ_DEADLINE_MS } from "../src/postbox-reader.js";
import type { OpenMailroom, ReaderEnding } from "../src/postbox-reader.js";

const Turn = Schema.Literals(["more", "idle", "fail", "dbMissing", "hang"]);

type TurnKind = typeof Turn.Type;

const Step = Schema.Union([
  Schema.Struct({ alarm: Turn }),
  Schema.Struct({ swap: Schema.Literal(true) }),
  Schema.Struct({
    quiet: Schema.Int.check(Schema.isBetween({ maximum: 120_000, minimum: 1 })),
  }),
]);

type CellStep = typeof Step.Type;

const histories = Arbitrary.array(Arbitrary.schema(Step), { maxLength: 24 });

const expected: Record<TurnKind, ReaderEnding> = {
  dbMissing: "failed",
  fail: "failed",
  hang: "stalled",
  idle: "idle",
  more: "more",
};

const unavailable = new PostboxReaderFailed({
  kind: "Unavailable",
  reason: "MailboxClientError: Mailbox subscription disconnected",
});

const noDb = PostboxReaderFailed.fromCause(
  Cause.die(new Error("SQL error: no db for Postbox:257dbc01"))
);

const mailroomLayer = Layer.succeed(
  Mailroom,
  Mailroom.of({
    nameOf: () => Effect.die("unused"),
    seal: () => Effect.die("unused"),
    send: () => Effect.die("unused"),
    surface: () => Effect.void,
    tell: () => Effect.void,
  })
);

interface Wired {
  readonly instance: number;
  readonly mailroom: OpenMailroom;
  readonly turn: number;
}

const simulateCell = Effect.fn("simulatePostboxCell")(function* simulateCell(
  history: readonly CellStep[]
) {
  let alarm = Option.none<number>();
  let live = 0;
  let turn: number | undefined;
  let turns = 0;
  let plan: TurnKind = "idle";
  const closed = new Set<number>();
  const violations: string[] = [];
  const wired: Wired[] = [];
  const reads: Wired[] = [];

  const inside = (instance: number, what: string) => {
    if (closed.has(instance)) {
      violations.push(`${what} on instance ${instance} after its db closed`);
    } else if (turn === undefined) {
      violations.push(`${what} on instance ${instance} outside any turn`);
    }
  };

  const instanceOf = (instance: number) => {
    const reader = PostboxReader.of({
      read: (mailroom) =>
        Effect.suspend(() => {
          inside(instance, "read");
          const source = wired.find((entry) => entry.mailroom === mailroom);
          reads.push({ instance, mailroom, turn: turn ?? -1 });

          if (source === undefined || source.turn !== turn) {
            violations.push(
              `turn ${turn} read a mailroom wired in turn ${source?.turn}`
            );
          }

          if (closed.has(instance)) {
            return Effect.fail(noDb);
          }

          if (plan === "hang") {
            return Effect.never;
          }

          if (plan === "fail" || plan === "dbMissing") {
            return Effect.fail(plan === "fail" ? unavailable : noDb);
          }

          return Effect.succeed(plan);
        }),
      wire: Effect.sync(() => {
        inside(instance, "wire");

        const mailroom: OpenMailroom = {
          inbox: {
            acquire: () => Effect.die("unused"),
            page: () => Effect.die("unused"),
            wait: () => Effect.die("unused"),
          },
          layer: mailroomLayer,
        };

        wired.push({ instance, mailroom, turn: turn ?? -1 });

        return mailroom;
      }),
    });

    return readerHost(
      {
        get: Effect.sync(() => {
          inside(instance, "getAlarm");

          return alarm;
        }),
        set: (at) =>
          Effect.sync(() => {
            inside(instance, "setAlarm");
            alarm = Option.some(at);
          }),
      },
      () => reader
    );
  };

  const construct = Effect.fn("constructPostbox")(function* construct(
    instance: number
  ) {
    const made = instanceOf(instance);
    turn = -instance - 1;
    yield* made.start;
    turn = undefined;

    return made;
  });

  let current = yield* construct(live);
  const endings: ReaderEnding[] = [];

  for (const step of history) {
    if ("swap" in step) {
      closed.add(live);
      live += 1;
      current = yield* construct(live);
      yield* Effect.yieldNow;
      continue;
    }

    if ("quiet" in step) {
      yield* TestClock.adjust(step.quiet);
      continue;
    }

    expect(Option.isSome(alarm), "the reader alarm is always armed").toBe(true);
    const due = Option.getOrElse(alarm, () => 0);
    const now = yield* Clock.currentTimeMillis;

    if (due > now) {
      yield* TestClock.adjust(due - now);
    }

    plan = step.alarm;
    const started = yield* Clock.currentTimeMillis;
    turns += 1;
    turn = turns;
    const fiber = yield* current.alarm.pipe(Effect.forkChild);

    if (plan === "hang") {
      yield* TestClock.adjust(READ_DEADLINE_MS);
    }

    const ending = yield* Fiber.join(fiber);
    const ended = yield* Clock.currentTimeMillis;
    turn = undefined;
    endings.push(ending);

    expect(ending).toBe(expected[step.alarm]);
    expect(Option.getOrUndefined(alarm), "the next alarm is armed").toBe(
      ending === "more" ? ended : started + LONG_POLL_MS
    );
    yield* Effect.yieldNow;
  }

  expect(violations).toStrictEqual([]);

  const alarmTurns = wired.filter((entry) => entry.turn > 0);
  expect(
    alarmTurns.map((entry) => entry.turn),
    "every turn wires once"
  ).toStrictEqual(Array.from({ length: turns }, (_, index) => index + 1));

  return { endings, reads, wired };
});

describe("Postbox reader alarm host", () => {
  it.effect.prop(
    "every read runs inside an alarm turn of the live instance with that turn's client, and an alarm stays armed",
    { history: histories },
    ({ history }) => simulateCell(history).pipe(Effect.scoped),
    { arbitrary: { runs: 200 } }
  );

  it.effect(
    "the 10-26 sequence: a db lost under the reader, then a mailbox failure, then the next alarm reads with a fresh client",
    () =>
      Effect.gen(function* tenTwentySix() {
        const { endings, reads, wired } = yield* simulateCell([
          { alarm: "more" },
          { swap: true },
          { alarm: "dbMissing" },
          { alarm: "fail" },
          { alarm: "idle" },
        ]);

        expect(endings).toStrictEqual(["more", "failed", "failed", "idle"]);
        expect(new Set(wired.map(({ mailroom }) => mailroom)).size).toBe(
          wired.length
        );
        expect(reads.at(-1)?.mailroom).toBe(wired.at(-1)?.mailroom);
        expect(reads.at(-1)?.instance).toBe(1);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a read that hangs is stopped at the deadline with one warning, and the next alarm re-wires",
    () =>
      Effect.gen(function* hung() {
        const lines: string[] = [];

        const { endings, wired } = yield* simulateCell([
          { alarm: "hang" },
          { alarm: "idle" },
        ]).pipe(
          Effect.provide(
            Logger.layer([
              Logger.formatSimple.pipe(Logger.map((line) => lines.push(line))),
            ])
          )
        );

        expect(endings).toStrictEqual(["stalled", "idle"]);
        expect(wired.filter(({ turn }) => turn > 0)).toHaveLength(2);
        expect(
          lines.filter((line) => line.includes("made no progress"))
        ).toHaveLength(1);
        expect(
          lines.find((line) => line.includes("made no progress"))
        ).toContain("Next check");
      }).pipe(Effect.scoped)
  );
});
