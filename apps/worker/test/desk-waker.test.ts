import { expect, it } from "@effect/vitest";
import type { DeskLease, DeskWakeResult } from "@mischief/core/desk-wake";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Clock, Deferred, Effect, Fiber, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import type { DeskWake } from "../src/desk-wake-mail.js";
import { deskWaker } from "../src/desk-waker.js";

const desk = "sample/desk";

const trigger = (messageId: string, seq = 9): DeskWake => ({
  $type: "sh.mschf.ratking.desk.wake",
  messageId,
  name: desk,
  recordedAt: "2026-11-18T22:19:33.000Z",
  seq,
  wake: true,
});

const makeWorld = (duringRestore = Effect.void) => {
  const storage = nodeSqlStorage(":memory:");
  const notices: string[] = [];
  const calls: string[] = [];
  const noticeText: string[] = [];

  let receipt: typeof DeskWakeResult.Type = {
    reason: "restored",
    result: "restored",
  };

  let lease: typeof DeskLease.Type | null = { live: true };
  let checks = 0;
  let scheduled: number | null = null;

  const boot = () =>
    deskWaker({
      alarms: {
        clear: Effect.sync(() => {
          scheduled = null;
        }),
        set: (at) =>
          Effect.sync(() => {
            scheduled = at;
          }),
      },
      host: {
        leaseLive: () =>
          Effect.sync(() => {
            checks += 1;

            return lease;
          }),
        wake: (_name, id) =>
          Effect.sync(() => {
            calls.push(id);

            return receipt;
          }).pipe(Effect.tap(() => duringRestore)),
      },
      notify: (key, _name, text) =>
        Effect.sync(() => {
          notices.push(key);
          noticeText.push(text);
        }),
      storage,
    });

  let object = boot();

  const fire = Effect.gen(function* fireWhenDue() {
    if (scheduled === null) {
      return yield* Effect.die("No desk wake alarm was set");
    }

    yield* TestClock.setTime(scheduled);
    yield* object.alarm;

    return yield* object.inspect;
  });

  return {
    calls,
    checks: () => checks,
    fire,
    notices,
    noticeText,
    storage,
    inspect: Effect.suspend(() => object.inspect),
    alarm: Effect.suspend(() => object.alarm),
    deadline: () => scheduled,
    reboot: () => {
      object = boot();
    },
    setLease: (next: boolean | null) => {
      lease = next === null ? null : { live: next };
    },
    refuseLease: (reason: string) => {
      lease = { permanent: true, reason };
    },
    setReceipt: (next: typeof receipt) => {
      receipt = next;
    },
    setResult: (next: (typeof receipt)["result"]) => {
      receipt = { reason: next, result: next };
    },
    wake: (record: DeskWake) => Effect.suspend(() => object.wake(record)),
  };
};

it.effect(
  "restores once, holds reading across an unknown lease, then sleeps when the lease is confirmed dead",
  () =>
    Effect.gen(function* readingLease() {
      const world = makeWorld();
      yield* world.wake(trigger("a"));
      expect((yield* world.inspect).state).toBe("waking");
      const reading = yield* world.fire;
      expect(reading.state).toBe("reading");
      expect(reading.alarmAt).toBeGreaterThanOrEqual(300_000);
      expect(reading.alarmAt).toBeLessThanOrEqual(330_000);
      yield* world.alarm;
      expect(world.checks()).toBe(0);
      yield* world.wake(trigger("joined"));
      expect(world.deadline()).toBe(yield* Clock.currentTimeMillis);
      expect(yield* world.fire).toMatchObject({
        alarmAt: reading.alarmAt,
        pending: null,
        state: "reading",
      });
      world.reboot();
      world.setLease(null);
      expect((yield* world.fire).state).toBe("reading");
      world.setLease(false);
      expect((yield* world.fire).state).toBe("asleep");
      expect(world.deadline()).toBeNull();
      yield* world.wake(trigger("a", 17));
      yield* world.wake(trigger("joined"));
      expect(world.deadline()).toBeNull();
      expect(world.calls).toEqual(["a"]);
      expect(
        world.storage.sql
          .exec("SELECT seq FROM desk_waker_messages WHERE message_id = 'a'")
          .toArray()
      ).toMatchObject([{ seq: 9 }]);
    })
);

it.effect(
  "a new trigger while reading probes immediately and wakes when the reader has exited",
  () =>
    Effect.gen(function* lateTrigger() {
      const world = makeWorld();
      yield* world.wake(trigger("first"));
      const reading = yield* world.fire;
      world.setLease(false);
      const now = yield* Clock.currentTimeMillis;
      yield* world.wake(trigger("next"));
      expect(world.deadline()).toBe(now);
      expect(world.deadline()).toBeLessThan(reading.alarmAt ?? 0);
      expect(yield* world.fire).toMatchObject({
        attempts: 0,
        messageId: "next",
        pending: null,
        state: "waking",
      });
      expect((yield* world.fire).state).toBe("reading");
      expect(world.calls).toEqual(["first", "next"]);
    })
);

it.effect(
  "an unavailable immediate probe preserves only the latest trigger for the regular lease alarm",
  () =>
    Effect.gen(function* pendingAcrossRestart() {
      const world = makeWorld();
      yield* world.wake(trigger("first"));
      const reading = yield* world.fire;
      world.setLease(null);
      yield* world.wake(trigger("obsolete"));
      yield* world.fire;
      yield* world.wake(trigger("latest"));
      expect(yield* world.fire).toMatchObject({
        pending: { messageId: "latest", probeAt: reading.alarmAt },
        state: "reading",
      });
      expect(world.deadline()).toBe(reading.alarmAt);
      world.reboot();
      world.setLease(false);
      expect(yield* world.fire).toMatchObject({
        messageId: "latest",
        pending: null,
        state: "waking",
      });
      expect((yield* world.fire).state).toBe("reading");
      expect(world.calls).toEqual(["first", "latest"]);
    })
);

it.effect(
  "a refused probe stops the pending wake and records its reason without trying a restore",
  () =>
    Effect.gen(function* refuseProbe() {
      const world = makeWorld();
      yield* world.wake(trigger("first"));
      yield* world.fire;
      world.refuseLease("Machine not opted in");
      yield* world.wake(trigger("refused-probe"));
      expect(yield* world.fire).toMatchObject({
        alarmAt: null,
        attempts: 1,
        messageId: "refused-probe",
        pending: null,
        reason: "Machine not opted in",
        state: "wake-failed",
      });
      expect(world.notices).toEqual(["failed:refused-probe"]);
      expect(world.calls).toEqual(["first"]);
    })
);

it.effect(
  "an incoming trigger joins a wake without waiting for the slow host",
  () =>
    Effect.gen(function* joinWhileRestoring() {
      const entered = yield* Deferred.make<true>();
      const release = yield* Deferred.make<true>();

      const world = makeWorld(
        Deferred.succeed(entered, true).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.asVoid
        )
      );

      yield* world.wake(trigger("first"));
      const running = yield* world.fire.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* world.wake(trigger("joined"));
      expect(world.calls).toEqual(["first"]);
      yield* Deferred.succeed(release, true);
      expect((yield* Fiber.join(running)).state).toBe("reading");
      world.setLease(false);
      expect((yield* world.fire).state).toBe("asleep");
      yield* world.wake(trigger("joined"));
      expect(world.deadline()).toBeNull();
    })
);

it.effect(
  "retries after 5, 20 and 60 minutes and alarms once, then recovers on a new message id",
  () =>
    Effect.gen(function* failures() {
      const world = makeWorld();
      world.setResult("failed");
      yield* world.wake(trigger("initial"));

      for (const delay of [300_000, 1_200_000, 3_600_000]) {
        world.reboot();
        expect((yield* world.fire).state).toBe("backoff");
        expect(world.deadline()).toBe((yield* Clock.currentTimeMillis) + delay);
        yield* world.alarm;
      }

      expect((yield* world.fire).state).toBe("wake-failed");
      expect(world.calls).toEqual(Array.from({ length: 4 }, () => "initial"));
      expect(world.notices).toEqual(["failed:initial"]);
      yield* world.alarm;
      yield* world.wake(trigger("initial"));
      expect(world.deadline()).toBeNull();
      expect(world.notices).toEqual(["failed:initial"]);
      world.setResult("restored");
      yield* world.wake(trigger("new", 2));
      expect((yield* world.fire).state).toBe("reading");
      expect(world.calls.at(-1)).toBe("new");
    })
);

it.effect(
  "a permanent Muster refusal stops immediately and alarms with the reason",
  () =>
    Effect.gen(function* refusalAndRecovery() {
      const world = makeWorld();
      world.setReceipt({
        permanent: true,
        reason: "Machine has not opted in to desk wake",
        result: "failed",
      });
      yield* world.wake(trigger("refused"));
      expect(yield* world.fire).toMatchObject({
        alarmAt: null,
        attempts: 1,
        state: "wake-failed",
      });
      expect(world.notices).toEqual(["failed:refused"]);
      expect(world.noticeText[0]).toContain(
        "Machine has not opted in to desk wake"
      );
      expect(world.calls).toEqual(["refused"]);
    })
);

it.effect(
  "in-flight duplicates retry every five minutes without spending failures and expose readiness on restore",
  () =>
    Effect.gen(function* waitForOriginal() {
      const world = makeWorld();
      world.setReceipt({
        inProgress: true,
        ready: false,
        reason: "wake in progress",
        result: "failed",
      });
      yield* world.wake(trigger("in-progress"));

      for (const _ of Array.from({ length: 5 })) {
        expect(yield* world.fire).toMatchObject({
          attempts: 0,
          ready: false,
          state: "backoff",
        });
        expect(world.deadline()).toBe(
          (yield* Clock.currentTimeMillis) + 300_000
        );
        expect(world.notices).toEqual([]);
        world.reboot();
      }

      world.setReceipt({
        ready: true,
        reason: "original restore finished",
        result: "restored",
      });
      expect(yield* world.fire).toMatchObject({
        attempts: 1,
        ready: true,
        state: "reading",
      });
      expect(world.calls).toEqual(
        Array.from({ length: 6 }, () => "in-progress")
      );
    })
);

it.effect(
  "alarms on the seventh wake in a rolling day without blocking it",
  () =>
    Effect.gen(function* churn() {
      const world = makeWorld();
      world.setResult("lost");
      yield* world.wake(trigger("old"));
      expect((yield* world.fire).state).toBe("asleep");
      yield* TestClock.adjust(24 * 60 * 60 * 1000);

      for (const index of Array.from({ length: 8 }, (_, i) => i)) {
        yield* world.wake(trigger(`wake-${index}`));
        expect((yield* world.fire).state).toBe("asleep");
      }

      expect(world.notices).toEqual(["churn:wake-6"]);
      expect(world.calls).toHaveLength(9);
    })
);

const History = Schema.Array(
  Schema.Struct({
    id: Schema.Int.check(Schema.isBetween({ maximum: 7, minimum: 0 })),
    reboot: Schema.Boolean,
    repeats: Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 0 })),
  })
).check(Schema.isMaxLength(24));

it.effect.prop(
  "replayed histories admit each distinct trigger at most once, across eviction and sequence changes",
  {
    history: Arbitrary.schema(History),
  },
  ({ history }) =>
    Effect.gen(function* replay() {
      const world = makeWorld();
      const seen = new Set<string>();
      world.setResult("lost");

      for (const { id, reboot, repeats } of history) {
        const key = `event-${id}`;
        yield* world.wake(trigger(key));

        if (reboot) {
          world.reboot();
        }

        for (let index = 0; index < repeats; index += 1) {
          yield* world.wake(trigger(key, index));
        }

        if (!seen.has(key)) {
          seen.add(key);
          expect((yield* world.fire).state).toBe("asleep");
        }

        expect(world.deadline()).toBeNull();
        expect(world.calls).toEqual([...seen]);
      }
    })
);
