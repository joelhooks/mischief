import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Ref, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import { SpendLedger } from "../src/box/spend-ledger.js";
import type { SpendAlarm } from "../src/box/spend-ledger.js";
import { SpendLimits } from "../src/box/spend-protocol.js";

const browser = { imageKey: "browser", peonId: "browser-a" } as const;

it.effect(
  "retains admitted and streamed spend, plus the alarm latch, across manager restarts and resets them by UTC day",
  () =>
    Effect.gen(function* restart() {
      const fs = yield* FileSystem.FileSystem;

      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "model-spend-test-",
      });

      const alarms = yield* Ref.make<SpendAlarm[]>([]);

      const layer = () =>
        SpendLedger.layer(
          `${dir}/spend.sqlite`,
          { browser: { dailyTokens: 100, ratePerMin: 20 } },
          (alarm) => Ref.update(alarms, (events) => [...events, alarm])
        );

      yield* TestClock.setTime(86_399_000);

      const receipt = yield* Effect.gen(function* firstManager() {
        const ledger = yield* SpendLedger;
        const permit = yield* ledger.admit(browser, 12);

        if (permit.status !== "metered") {
          return yield* Effect.die(
            "The first browser request was not admitted"
          );
        }

        yield* ledger.record({ receipt: permit.receipt, tokens: 79 });
        expect(yield* Ref.get(alarms)).toEqual([]);
        yield* ledger.record({ receipt: permit.receipt, tokens: 80 });

        return permit.receipt;
      }).pipe(Effect.provide(layer()));

      yield* Effect.gen(function* restartedManager() {
        const ledger = yield* SpendLedger;
        yield* ledger.record({ receipt, tokens: 80 });
        yield* ledger.record({ receipt, tokens: 14 });
        expect(yield* ledger.admit(browser, 21)).toEqual({
          status: "denied",
          reason: "daily",
        });
        expect((yield* ledger.admit(browser, 20)).status).toBe("metered");
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
        expect(yield* Ref.get(alarms)).toEqual([
          {
            day: 0,
            limit: 100,
            metric: "daily",
            peonId: browser.peonId,
            used: 80,
          },
        ]);

        yield* TestClock.adjust(1000);
        yield* ledger.record({ receipt, tokens: 200 });
        expect((yield* ledger.admit(browser, 100)).status).toBe("metered");
        expect(yield* ledger.admit(browser, 1)).toEqual({
          status: "denied",
          reason: "daily",
        });
        expect((yield* Ref.get(alarms)).map((alarm) => alarm.day)).toEqual([
          0, 1,
        ]);
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

it("requires browser limits by default and leaves full unmetered until configured", () => {
  expect(Schema.decodeSync(SpendLimits)({})).toEqual({
    browser: { dailyTokens: 2_000_000, ratePerMin: 20 },
  });
});
