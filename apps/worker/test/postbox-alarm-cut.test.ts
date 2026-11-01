import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { Mailroom } from "../src/mailroom-port.js";
import { readerHost } from "../src/postbox-reader-host.js";
import type { ReaderMarks } from "../src/postbox-reader-marks.js";
import { PostboxReader } from "../src/postbox-reader.js";
import type { OpenMailroom } from "../src/postbox-reader.js";
import { cutAt, cutEffect, neverCut } from "./alarm-cut.js";
import type { Cut } from "./alarm-cut.js";

const mailroom: OpenMailroom = {
  head: Effect.die("unused"),
  inbox: {
    acquire: () => Effect.die("unused"),
    page: () => Effect.die("unused"),
    wait: () => Effect.die("unused"),
  },
  layer: Layer.succeed(
    Mailroom,
    Mailroom.of({
      nameOf: () => Effect.die("unused"),
      seal: () => Effect.die("unused"),
      send: () => Effect.die("unused"),
      surface: () => Effect.void,
      tell: () => Effect.void,
    })
  ),
};

interface Inbox {
  readonly batches: number;
  cursor: number;
  readonly read: number[];
}

interface Cell {
  pending: Option.Option<number>;
  marks: Option.Option<ReaderMarks>;
}

const hostOn = (cell: Cell, inbox: Inbox, cut: Cut) =>
  readerHost(
    {
      get: Effect.sync(() => cell.pending),
      set: (at) =>
        cutEffect(
          cut,
          "alarms.set",
          Effect.sync(() => {
            cell.pending = Option.some(at);
          })
        ),
    },
    {
      get: Effect.sync(() => cell.marks),
      set: (marks) =>
        cutEffect(
          cut,
          "marks.set",
          Effect.sync(() => {
            cell.marks = Option.some(marks);
            cut.landed += 1;
          })
        ),
    },
    {
      head: Effect.die("a more or idle turn never probes the mailbox head"),
      notice: () => Effect.die("a more or idle turn never sends a notice"),
    },
    () =>
      PostboxReader.of({
        read: () =>
          cutEffect(
            cut,
            `read ${inbox.cursor}`,
            Effect.sync(() => {
              inbox.read.push(inbox.cursor);
              inbox.cursor += 1;
              cut.landed += 1;

              return inbox.cursor < inbox.batches ? "more" : "idle";
            })
          ),
        wire: cutEffect(cut, "wire", Effect.succeed(mailroom)),
      })
  );

const fire = (cell: Cell, inbox: Inbox, cut: Cut) =>
  Effect.gen(function* fireAlarm() {
    cell.pending = Option.none();
    cut.landed = 0;

    const turn = yield* hostOn(cell, inbox, cut).alarm.pipe(
      Effect.ignoreCause,
      Effect.forkScoped
    );

    yield* Effect.raceFirst(
      Fiber.join(turn),
      Effect.sleep(1).pipe(Effect.repeat({ while: () => cut.tripped === null }))
    );

    const after = {
      landed: cut.landed,
      pending: cell.pending,
      tripped: cut.tripped,
    };

    yield* Fiber.interrupt(turn);

    return after;
  });

it.live.prop(
  "a Postbox alarm turn cut at any await leaves its next alarm armed, and the next alarms read every batch exactly once",
  {
    batches: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 }))
    ),
    cut: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 1 }))
    ),
  },
  ({ batches, cut }) =>
    Effect.gen(function* cutTurn() {
      const cell: Cell = { marks: Option.none(), pending: Option.some(0) };
      const inbox: Inbox = { batches, cursor: 0, read: [] };
      const cutting = cutAt(cut);

      for (let turn = 0; turn < 12; turn += 1) {
        expect(
          Option.isSome(cell.pending),
          "the Postbox has an alarm armed, so its reader runs again"
        ).toBe(true);

        if (inbox.cursor >= batches) {
          break;
        }

        const after = yield* fire(
          cell,
          inbox,
          cutting.tripped === null ? cutting : neverCut()
        );

        if (after.tripped !== null) {
          expect(
            Option.isSome(after.pending) || after.landed === 0,
            `cut at ${after.tripped} after ${after.landed} writes landed`
          ).toBe(true);

          if (Option.isNone(cell.pending)) {
            cell.pending = Option.some(0);
          }
        }
      }

      expect(inbox.read).toStrictEqual(
        Array.from({ length: batches }, (_, index) => index)
      );
      expect(Option.isSome(cell.pending)).toBe(true);
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 60 }, timeout: 60_000 }
);
