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
import { PostboxFailed } from "../src/postbox-failed.js";
import { PostboxReaderFailed } from "../src/postbox-reader-failed.js";
import { readerHost } from "../src/postbox-reader-host.js";
import type { ReaderMarks } from "../src/postbox-reader-marks.js";
import { deadlineFor, PostboxReader } from "../src/postbox-reader.js";
import type { OpenMailroom, ReaderEnding } from "../src/postbox-reader.js";

const ACTIVE_WINDOW_MS = 20_000;

const IDLE_WINDOW_MS = 60_000;

const BEHIND_MS = 15 * 60_000;

const Turn = Schema.Literals(["more", "idle", "fail", "dbMissing", "hang"]);

type TurnKind = typeof Turn.Type;

const Probe = Schema.Literals(["waiting", "caughtUp", "fails"]);

type ProbeKind = typeof Probe.Type;

const Desk = Schema.Literals(["accepts", "refuses"]);

type DeskKind = typeof Desk.Type;

const Step = Schema.Union([
  Schema.Struct({ alarm: Turn }),
  Schema.Struct({ swap: Schema.Literal(true) }),
  Schema.Struct({
    quiet: Schema.Int.check(
      Schema.isBetween({ maximum: 1_200_000, minimum: 1 })
    ),
  }),
  Schema.Struct({ probe: Probe }),
  Schema.Struct({ desk: Desk }),
]);

type CellStep = typeof Step.Type;

const histories = Arbitrary.array(Arbitrary.schema(Step), { maxLength: 64 });

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

const HEAD = 9;

const CURSOR = 7;

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

interface Notice {
  readonly accepted: boolean;
  readonly body: string;
  readonly summary: string;
  readonly turn: number;
}

interface TurnRecord {
  readonly ended: number;
  readonly ending: ReaderEnding;
  readonly lastGoodAt: number;
  readonly probe: ProbeKind;
  readonly window: number;
}

const modelTurn = (
  marks: ReaderMarks,
  ending: ReaderEnding,
  ended: number,
  probe: ProbeKind,
  desk: DeskKind
) => {
  if (ending === "more" || ending === "idle") {
    return {
      marks: {
        emptyTurns: ending === "idle" ? Math.min(marks.emptyTurns + 1, 3) : 0,
        lastReadAt: ended,
        noticed: false,
      },
      notices: [],
    };
  }

  const due = !marks.noticed && ended - marks.lastReadAt > BEHIND_MS;
  const sends = due && probe === "waiting";

  return {
    marks: {
      ...marks,
      emptyTurns: 0,
      noticed: marks.noticed || (sends && desk === "accepts"),
    },
    notices: sends ? [desk === "accepts"] : [],
  };
};

const simulateCell = Effect.fn("simulatePostboxCell")(function* simulateCell(
  history: readonly CellStep[]
) {
  let alarm = Option.none<number>();
  let stored = Option.none<ReaderMarks>();
  let live = 0;
  let turn: number | undefined;
  let turns = 0;
  let plan: TurnKind = "idle";
  let probe: ProbeKind = "waiting";
  let desk: DeskKind = "accepts";
  const closed = new Set<number>();
  const violations: string[] = [];
  const wired: Wired[] = [];
  const reads: (Wired & { readonly window: number })[] = [];
  const notices: Notice[] = [];
  const records: TurnRecord[] = [];

  const inside = (instance: number, what: string) => {
    if (closed.has(instance)) {
      violations.push(`${what} on instance ${instance} after its db closed`);
    } else if (turn === undefined) {
      violations.push(`${what} on instance ${instance} outside any turn`);
    }
  };

  const instanceOf = (instance: number) => {
    const reader = PostboxReader.of({
      read: (mailroom, window) =>
        Effect.suspend(() => {
          inside(instance, "read");
          const source = wired.find((entry) => entry.mailroom === mailroom);
          reads.push({ instance, mailroom, turn: turn ?? -1, window });

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
          head: Effect.die("unused"),
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
      {
        get: Effect.sync(() => {
          inside(instance, "getMarks");

          return stored;
        }),
        set: (marks) =>
          Effect.sync(() => {
            inside(instance, "setMarks");
            stored = Option.some(marks);
          }),
      },
      {
        head: Effect.suspend(() => {
          inside(instance, "probe");

          if (probe === "fails") {
            return Effect.fail(
              new PostboxFailed({ reason: "the mailbox list failed" })
            );
          }

          return Effect.succeed({
            cursor: CURSOR,
            head: probe === "waiting" ? HEAD : CURSOR,
          });
        }),
        notice: (summary, body) =>
          Effect.sync(() => {
            inside(instance, "notice");
            const accepted = desk === "accepts";
            notices.push({ accepted, body, summary, turn: turn ?? -1 });

            return accepted;
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

  let model: ReaderMarks = {
    emptyTurns: 0,
    lastReadAt: yield* Clock.currentTimeMillis,
    noticed: false,
  };

  const modelNotices: boolean[] = [];
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

    if ("probe" in step) {
      ({ probe } = step);
      continue;
    }

    if ("desk" in step) {
      ({ desk } = step);
      continue;
    }

    expect(Option.isSome(alarm), "the reader alarm is always armed").toBe(true);
    const due = Option.getOrElse(alarm, () => 0);
    const now = yield* Clock.currentTimeMillis;

    if (due > now) {
      yield* TestClock.adjust(due - now);
    }

    plan = step.alarm;
    const window = model.emptyTurns >= 3 ? IDLE_WINDOW_MS : ACTIVE_WINDOW_MS;
    const started = yield* Clock.currentTimeMillis;
    turns += 1;
    turn = turns;
    const fiber = yield* current.alarm.pipe(Effect.forkChild);

    if (plan === "hang") {
      yield* TestClock.adjust(deadlineFor(window) - 1);
      expect(
        fiber.pollUnsafe(),
        `a hung read in a ${window / 1000} s window is not stalled before its deadline`
      ).toBeUndefined();
      yield* TestClock.adjust(1);
    }

    const ending = yield* Fiber.join(fiber);
    const ended = yield* Clock.currentTimeMillis;
    turn = undefined;
    endings.push(ending);
    records.push({
      ended,
      ending,
      lastGoodAt: model.lastReadAt,
      probe,
      window,
    });

    expect(ending).toBe(expected[step.alarm]);
    expect(reads.at(-1)?.window, "the read long-polls for the window").toBe(
      window
    );
    expect(Option.getOrUndefined(alarm), "the next alarm is armed").toBe(
      ending === "more" ? ended : started + window
    );

    const next = modelTurn(model, ending, ended, probe, desk);
    model = next.marks;
    modelNotices.push(...next.notices);
    expect(Option.getOrUndefined(stored)).toStrictEqual(model);
    yield* Effect.yieldNow;
  }

  expect(violations).toStrictEqual([]);
  expect(notices.map(({ accepted }) => accepted)).toStrictEqual(modelNotices);

  const alarmTurns = wired.filter((entry) => entry.turn > 0);
  expect(
    alarmTurns.map((entry) => entry.turn),
    "every turn wires once"
  ).toStrictEqual(Array.from({ length: turns }, (_, index) => index + 1));

  return { endings, notices, reads, records, wired };
});

const good = (ending: ReaderEnding) => ending === "more" || ending === "idle";

describe("Postbox reader alarm host", () => {
  it.effect.prop(
    "every read runs inside an alarm turn of the live instance with that turn's client, an alarm stays armed, and the marks follow the reader model",
    { history: histories },
    ({ history }) => simulateCell(history).pipe(Effect.scoped),
    { arbitrary: { runs: 300 } }
  );

  it.effect.prop(
    "an outage gets at most one delivered notice, only after a failed turn more than 15 min past the last good read with mail waiting",
    { history: histories },
    ({ history }) =>
      Effect.gen(function* oneNoticePerOutage() {
        const { notices, records } = yield* simulateCell(history);

        let delivered = 0;

        for (const [index, record] of records.entries()) {
          if (good(record.ending)) {
            delivered = 0;
          }

          for (const notice of notices.filter(
            ({ turn }) => turn === index + 1
          )) {
            expect(good(record.ending), "no notice while reads succeed").toBe(
              false
            );
            expect(record.probe, "no notice when the probe fails").toBe(
              "waiting"
            );
            expect(record.ended - record.lastGoodAt).toBeGreaterThan(BEHIND_MS);
            delivered += notice.accepted ? 1 : 0;
            expect(
              delivered,
              "one delivered notice per outage"
            ).toBeLessThanOrEqual(1);
          }
        }
      }).pipe(Effect.scoped),
    { arbitrary: { runs: 300 } }
  );

  it.effect.prop(
    "the window is 60 s exactly when the three turns before were empty, and 20 s otherwise",
    { history: histories },
    ({ history }) =>
      Effect.gen(function* backoff() {
        const { records } = yield* simulateCell(history);

        for (const [index, record] of records.entries()) {
          const previous = records.slice(Math.max(0, index - 3), index);

          const idle =
            previous.length === 3 &&
            previous.every(({ ending }) => ending === "idle");

          expect(record.window).toBe(idle ? IDLE_WINDOW_MS : ACTIVE_WINDOW_MS);
        }
      }).pipe(Effect.scoped),
    { arbitrary: { runs: 300 } }
  );

  it.effect(
    "a long outage sends one notice with the lag, the error and the head seq; a good read clears it, so the next outage sends another",
    () =>
      Effect.gen(function* twoOutages() {
        const { notices } = yield* simulateCell([
          { alarm: "fail" },
          { quiet: BEHIND_MS + 60_000 },
          { alarm: "fail" },
          { alarm: "hang" },
          { alarm: "dbMissing" },
          { alarm: "idle" },
          { alarm: "fail" },
          { quiet: BEHIND_MS + 60_000 },
          { alarm: "fail" },
          { alarm: "fail" },
        ]);

        expect(notices.map(({ turn }) => turn)).toStrictEqual([2, 7]);
        expect(notices[0]?.summary).toContain(`head seq ${HEAD}`);
        expect(notices[0]?.summary).toContain("16 min behind");
        expect(notices[0]?.body).toContain(unavailable.reason);
        expect(notices[0]?.body).toContain("Next check");
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a failed probe or a caught-up mailbox sends nothing, and a refused notice is tried again on the next failed turn",
    () =>
      Effect.gen(function* skipped() {
        const { notices } = yield* simulateCell([
          { alarm: "fail" },
          { quiet: BEHIND_MS + 60_000 },
          { probe: "fails" },
          { alarm: "fail" },
          { probe: "caughtUp" },
          { alarm: "fail" },
          { probe: "waiting" },
          { desk: "refuses" },
          { alarm: "fail" },
          { desk: "accepts" },
          { alarm: "fail" },
          { alarm: "fail" },
        ]);

        expect(
          notices.map(({ accepted, turn }) => [turn, accepted])
        ).toStrictEqual([
          [4, false],
          [5, true],
        ]);
      }).pipe(Effect.scoped)
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

  it.effect(
    "three empty turns step the window to 60 s, a hang there outlives the 20 s deadline, and mail steps it back to 20 s",
    () =>
      Effect.gen(function* idleBackoff() {
        const { records } = yield* simulateCell([
          { alarm: "idle" },
          { alarm: "idle" },
          { alarm: "idle" },
          { alarm: "idle" },
          { alarm: "more" },
          { alarm: "idle" },
          { alarm: "idle" },
          { alarm: "idle" },
          { alarm: "hang" },
          { alarm: "idle" },
        ]);

        expect(records.map(({ window }) => window / 1000)).toStrictEqual([
          20, 20, 20, 60, 60, 20, 20, 20, 60, 20,
        ]);
      }).pipe(Effect.scoped)
  );
});
