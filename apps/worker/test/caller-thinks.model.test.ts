import { expect, it } from "@effect/vitest";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Fiber, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

import { callerThinkHost } from "../src/caller-think-host.js";
import { callerThinkLedger, callerThinksFrom } from "../src/caller-thinks.js";
import { cutAt, cutEffect, frozenAfterCut, reaches } from "./alarm-cut.js";

const Command = Schema.Struct({
  caller: Schema.Literals(["a", "b"]),
  id: Schema.Literals(["one", "two", "three", "four"]),
  kind: Schema.Literals(["take", "release", "restart", "wait"]),
  millis: Schema.Int.check(Schema.isBetween({ maximum: 120, minimum: 0 })),
});

it.effect.prop(
  "caller leases follow an independent model across releases, expiry and replacement, without borrowing another caller's share",
  {
    commands: Schema.Array(Command).check(Schema.isMaxLength(80)),
    share: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
  },
  ({ commands, share }) =>
    Effect.sync(() => {
      const storage = {
        a: nodeSqlStorage(":memory:"),
        b: nodeSqlStorage(":memory:"),
      };

      const model = {
        a: new Map<string, number>(),
        b: new Map<string, number>(),
      };

      let ledgers = {
        a: callerThinkLedger(storage.a),
        b: callerThinkLedger(storage.b),
      };

      let now = 0;

      for (const command of commands) {
        const leases = model[command.caller];
        const ledger = ledgers[command.caller];

        if (command.kind === "wait") {
          now += command.millis;
          continue;
        }

        if (command.kind === "restart") {
          ledgers = {
            a: callerThinkLedger(storage.a),
            b: callerThinkLedger(storage.b),
          };
          continue;
        }

        if (command.kind === "release") {
          leases.delete(command.id);
          ledger.release(command.id);
          continue;
        }

        for (const [id, expires] of leases) {
          if (expires <= now) {
            leases.delete(id);
          }
        }

        const accepted = leases.has(command.id) || leases.size < share;

        const result = ledger.acquire({
          caller: command.caller,
          id: command.id,
          key: "think",
          now,
          objectName: `${command.caller}/run`,
          share,
          to: [command.caller, "desk"],
          ttlMs: 100,
        });

        expect(result.acquired).toBe(accepted);

        if (accepted && !leases.has(command.id)) {
          leases.set(command.id, now + 100);
        }

        if (accepted) {
          expect(result.expires).toBe(leases.get(command.id));
        }
      }
    }),
  { arbitrary: { runs: 300 } }
);

it.effect.prop(
  "a sustained crossing sends one caller notice and one desk copy, replacement retains pending notices, and a quiet interval permits a new crossing",
  { waits: Schema.Int.check(Schema.isBetween({ maximum: 30, minimum: 2 })) },
  ({ waits }) =>
    Effect.gen(function* crossingNotices() {
      const storage = nodeSqlStorage(":memory:");
      const deliveries: string[] = [];
      let alarm: number | null = null;

      const hostNow = () =>
        callerThinkHost({
          arm: (at) =>
            Effect.sync(() => {
              alarm = at;
            }),
          clear: Effect.sync(() => {
            alarm = null;
          }),
          ledger: callerThinkLedger(storage),
          send: (notice) =>
            Effect.sync(() => {
              deliveries.push(`${notice.serial}:${notice.to}`);
            }),
          share: 1,
          ttlMs: 100,
        });

      const input = {
        caller: "a",
        id: "active",
        key: "think",
        objectName: "a/run-one",
        to: ["a", "desk", "desk"],
      };

      yield* TestClock.setTime(0);
      expect((yield* hostNow().acquire(input)).acquired).toBe(true);

      for (let wait = 0; wait < waits; wait += 1) {
        yield* TestClock.setTime(wait);
        expect(
          (yield* hostNow().acquire({
            ...input,
            id: `waiting-${wait}`,
            objectName: "a/run-two",
          })).acquired
        ).toBe(false);
        yield* hostNow().alarm();
        yield* hostNow().alarm();
      }

      expect(deliveries.toSorted()).toEqual(["1:a", "1:desk"]);
      expect(alarm).toBeNull();

      yield* TestClock.setTime(waits + 101);
      expect(
        (yield* hostNow().acquire({ ...input, id: "next" })).acquired
      ).toBe(true);
      expect(
        (yield* hostNow().acquire({ ...input, id: "next-wait" })).acquired
      ).toBe(false);
      yield* hostNow().alarm();
      yield* hostNow().alarm();
      expect(deliveries.toSorted()).toEqual(["1:a", "1:desk", "2:a", "2:desk"]);
    }),
  { arbitrary: { runs: 40 } }
);

it.effect.prop(
  "every acquisition and notice boundary is armed before a cut, and a cut mid-think cannot retain its share after expiry",
  { at: Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 1 })) },
  ({ at }) =>
    Effect.gen(function* cutLease() {
      yield* TestClock.setTime(0);
      const storage = nodeSqlStorage(":memory:");
      const cut = cutAt(at);
      const ledger = callerThinkLedger(frozenAfterCut(storage, cut));
      let alarm: number | null = null;

      const host = callerThinkHost({
        arm: (time) =>
          cutEffect(
            cut,
            "arm",
            Effect.sync(() => {
              alarm = time;
            })
          ),
        clear: Effect.void,
        ledger,
        send: () => cutEffect(cut, "notice", Effect.void),
        share: 1,
        ttlMs: 100,
      });

      const input = {
        caller: "a",
        id: "active",
        key: "think",
        objectName: "a/run",
        to: ["a", "desk"],
      };

      const drive = Effect.gen(function* lostTurn() {
        yield* host.acquire(input);
        yield* cutEffect(cut, "mid-think", Effect.void);
        yield* host.acquire({ ...input, id: "waiting" });
        yield* host.alarm();
        reaches(cut, "after-notice");
      });

      const fiber = yield* drive.pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      expect(cut.tripped).not.toBeNull();

      if (cut.landed > 0) {
        expect(alarm).not.toBeNull();
      }

      const restored = callerThinkLedger(storage);

      const before = restored.acquire({
        ...input,
        id: "fresh",
        now: 99,
        share: 1,
        ttlMs: 100,
      });

      if (at > 1) {
        expect(before.acquired).toBe(false);
      }

      const after = restored.acquire({
        ...input,
        id: "fresh",
        now: 100,
        share: 1,
        ttlMs: 100,
      });

      expect(after.acquired).toBe(true);
    }),
  { arbitrary: { runs: 24 } }
);

it.effect.prop(
  "caller shares accept positive whole numbers and refuse malformed settings with a repair call",
  { value: Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 })) },
  ({ value }) =>
    Effect.sync(() => {
      expect(Result.getOrThrow(callerThinksFrom(String(value)))).toBe(value);
      expect(Result.getOrThrow(callerThinksFrom())).toBe(40);

      for (const malformed of [
        "0",
        "-1",
        "1.5",
        "NaN",
        "1e2",
        "Infinity",
        "9007199254740992",
      ]) {
        const result = callerThinksFrom(malformed);

        expect(Result.isFailure(result)).toBe(true);

        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain("MISCHIEF_CALLER_THINKS=40");
        }
      }
    })
);
