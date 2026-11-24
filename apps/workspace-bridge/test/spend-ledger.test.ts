import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Ref, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { uuidV4Unsafe } from "effect/crypto/SecureRandom";
import { TestClock } from "effect/testing";

import { SpendLedger } from "../src/box/spend-ledger.js";
import type { SpendAlarm } from "../src/box/spend-ledger.js";
import { SpendLimits } from "../src/box/spend-protocol.js";

const browser = { imageKey: "browser", peonId: "browser-a" } as const;

it.effect(
  "retains admitted and streamed spend across manager restarts and resets it by UTC day",
  () =>
    Effect.gen(function* restart() {
      const fs = yield* FileSystem.FileSystem;

      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "model-spend-test-",
      });

      const layer = () =>
        SpendLedger.layer(
          `${dir}/spend.sqlite`,
          {
            browser: {
              dailyTokens: 100,
              defaultOutputTokens: 1,
              ratePerMin: 20,
            },
          },
          () => Effect.void
        );

      yield* TestClock.setTime(86_399_000);
      const requestId = uuidV4Unsafe();

      const receipt = yield* Effect.gen(function* firstManager() {
        const ledger = yield* SpendLedger;
        const permit = yield* ledger.admit(browser, 12, undefined, requestId);

        if (permit.status !== "metered") {
          return yield* Effect.die(
            "The first browser request was not admitted"
          );
        }

        yield* ledger.record({ receipt: permit.receipt, tokens: 79 });
        yield* ledger.record({ receipt: permit.receipt, tokens: 80 });

        return permit.receipt;
      }).pipe(Effect.provide(layer()));

      yield* Effect.gen(function* restartedManager() {
        const ledger = yield* SpendLedger;
        expect(yield* ledger.admit(browser, 12, undefined, requestId)).toEqual({
          status: "metered",
          receipt,
          outputTokens: 1,
        });
        expect(
          yield* Effect.flip(
            ledger.admit(
              { ...browser, peonId: "browser-b" },
              12,
              undefined,
              requestId
            )
          )
        ).toMatchObject({ status: 409 });
        yield* ledger.record({ receipt, tokens: 80 });
        yield* ledger.record({ receipt, tokens: 14 });
        expect(yield* ledger.admit(browser, 21)).toEqual({
          status: "denied",
          reason: "daily",
        });
        expect((yield* ledger.admit(browser, 19)).status).toBe("metered");
        expect(yield* ledger.admit(browser, 0)).toEqual({
          status: "denied",
          reason: "daily",
        });
        expect(
          yield* ledger.admit(
            { ...browser, imageKey: "full", peonId: "full-a" },
            10_000
          )
        ).toEqual({ status: "uncapped" });
        expect(
          (yield* ledger.admit({ ...browser, peonId: "browser-b" }, 1)).status
        ).toBe("metered");
        yield* TestClock.adjust(1000);
        yield* ledger.record({ receipt, tokens: 200 });
        expect((yield* ledger.admit(browser, 99)).status).toBe("metered");
        expect(yield* ledger.admit(browser, 1)).toEqual({
          status: "denied",
          reason: "daily",
        });
      }).pipe(Effect.provide(layer()));
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect.prop(
  "rolling request limits survive a restart and midnight; a rejected attempt never extends the window",
  {
    rate: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 }))
    ),
    beforeMidnight: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 59_999 }))
    ),
  },
  ({ rate, beforeMidnight }) =>
    Effect.gen(function* rolling() {
      const fs = yield* FileSystem.FileSystem;

      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "model-rate-test-",
      });

      const layer = () =>
        SpendLedger.layer(
          `${dir}/rate.sqlite`,
          { browser: { dailyTokens: 2_000_000, ratePerMin: rate } },
          () => Effect.void
        );

      yield* TestClock.setTime(86_400_000 - beforeMidnight);

      yield* Effect.gen(function* fillWindow() {
        const ledger = yield* SpendLedger;

        const permits = yield* Effect.all(
          Array.from({ length: rate + 3 }, () => ledger.admit(browser, 1)),
          { concurrency: "unbounded" }
        );

        expect(
          permits.filter((permit) => permit.status === "metered")
        ).toHaveLength(rate);
        expect(
          permits.filter((permit) => permit.status === "denied")
        ).toHaveLength(3);
      }).pipe(Effect.provide(layer()));

      yield* Effect.gen(function* restartedWindow() {
        const ledger = yield* SpendLedger;
        yield* TestClock.adjust(beforeMidnight);
        expect(yield* ledger.admit(browser, 1)).toEqual({
          status: "denied",
          reason: "rate",
        });
        yield* TestClock.adjust(59_999 - beforeMidnight);
        expect(yield* ledger.admit(browser, 1)).toEqual({
          status: "denied",
          reason: "rate",
        });
        yield* TestClock.adjust(1);
        expect((yield* ledger.admit(browser, 1)).status).toBe("metered");
      }).pipe(Effect.provide(layer()));
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect.prop(
  "concurrent attempts reserve input and output atomically, settle refunds capacity, and live ceiling includes outstanding claims",
  {
    calls: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 12 }))
    ),
  },
  ({ calls }) =>
    Effect.gen(function* reserveAndRefund() {
      const limits = { browser: { dailyTokens: calls * 100, ratePerMin: 100 } };
      yield* Effect.gen(function* exerciseLedger() {
        const ledger = yield* SpendLedger;

        const permits = yield* Effect.all(
          Array.from({ length: calls * 2 }, () =>
            ledger.admit(browser, 10, 90)
          ),
          { concurrency: "unbounded" }
        );

        const accepted = permits.filter(
          (permit) => permit.status === "metered"
        );

        expect(accepted).toHaveLength(calls);
        const [first, second] = accepted;

        if (first === undefined || second === undefined) {
          return yield* Effect.die("Expected at least two durable holds");
        }

        expect(
          yield* ledger.record({
            receipt: first.receipt,
            tokens: 100 + calls * 10,
          })
        ).toEqual({ allowed: true });
        expect(
          yield* ledger.record({
            receipt: first.receipt,
            tokens: 101 + calls * 10,
          })
        ).toEqual({ allowed: false });
        expect(
          yield* ledger.record({
            receipt: second.receipt,
            tokens: 1,
            settled: true,
          })
        ).toEqual({ allowed: true });
        expect(
          yield* ledger.record({
            receipt: second.receipt,
            tokens: 1,
            settled: true,
          })
        ).toEqual({ allowed: true });
        const remaining = 98 - calls * 10;

        if (remaining > 1) {
          expect((yield* ledger.admit(browser, 1, remaining - 1)).status).toBe(
            "metered"
          );
        }

        expect(yield* ledger.admit(browser, 1, 1)).toEqual({
          status: "denied",
          reason: "daily",
        });

        return yield* Effect.void;
      }).pipe(
        Effect.provide(SpendLedger.layer(":memory:", limits, () => Effect.void))
      );
    })
);

it.effect(
  "a committed crossing survives shutdown before log or send and drains once on restart",
  () =>
    Effect.gen(function* pendingAlarm() {
      const fs = yield* FileSystem.FileSystem;

      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "spend-outbox-",
      });

      const file = `${dir}/outbox.sqlite`;
      const limits = { browser: { dailyTokens: 100, ratePerMin: 100 } };
      const logging = yield* Deferred.make<true>();
      const delivered = yield* Deferred.make<true>();
      const logs = yield* Ref.make<SpendAlarm[]>([]);
      const sends = yield* Ref.make<SpendAlarm[]>([]);
      yield* Effect.gen(function* firstManager() {
        const ledger = yield* SpendLedger;
        expect((yield* ledger.admit(browser, 80, 1)).status).toBe("metered");
        yield* Deferred.await(logging);
      }).pipe(
        Effect.provide(
          SpendLedger.layer(
            file,
            limits,
            () => Effect.die("Delivery cannot begin before logging"),
            () =>
              Deferred.succeed(logging, true).pipe(Effect.andThen(Effect.never))
          )
        )
      );

      const layer = () =>
        SpendLedger.layer(
          file,
          limits,
          (alarm) =>
            Ref.update(sends, (all) => [...all, alarm]).pipe(
              Effect.andThen(Deferred.succeed(delivered, true)),
              Effect.asVoid
            ),
          (alarm) => Ref.update(logs, (all) => [...all, alarm])
        );

      yield* Deferred.await(delivered).pipe(
        Effect.andThen(TestClock.adjust(1)),
        Effect.provide(layer())
      );
      yield* TestClock.adjust(1).pipe(Effect.provide(layer()));

      const expected = [
        {
          day: 0,
          limit: 100,
          metric: "daily",
          peonId: browser.peonId,
          used: 80,
        },
      ];

      expect(yield* Ref.get(logs)).toEqual(expected);
      expect(yield* Ref.get(sends)).toEqual(expected);
    }).pipe(Effect.provide(NodeServices.layer))
);

it("requires browser limits by default and leaves full unmetered until configured", () => {
  expect(Schema.decodeSync(SpendLimits)({})).toEqual({
    browser: { dailyTokens: 2_000_000, ratePerMin: 20 },
  });
});
