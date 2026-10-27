import { expect, it } from "@effect/vitest";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Schema } from "effect";

import {
  dayTotals,
  dedupeKey,
  tally,
  utcDay,
  warnText,
} from "../src/think-tally.js";

const Tokens = Schema.Int.check(
  Schema.isBetween({ maximum: 6_000_000, minimum: 0 })
);

const Call = Schema.Struct({
  day: Schema.Literals(["2026-10-16", "2026-10-17"]),
  key: Schema.Literals(["t1", "t2", "t3"]),
  run: Schema.Literals(["a", "b", "c"]),
  tokens: Tokens,
});

const Calls = Schema.Array(Call).check(Schema.isMaxLength(40));

const sumWhere = (
  calls: readonly (typeof Call.Type)[],
  matches: (call: typeof Call.Type) => boolean
) => calls.filter(matches).reduce((total, { tokens }) => total + tokens, 0);

it.prop(
  "stored day totals are the sums of the calls",
  { calls: Calls },
  ({ calls }) => {
    const storage = nodeSqlStorage(":memory:");

    for (const { day, key, run, tokens } of calls) {
      tally(storage, day, run, key, tokens);
    }

    for (const day of new Set(calls.map((call) => call.day))) {
      expect(dayTotals(storage, day)).toStrictEqual({
        calls: calls.filter((call) => call.day === day).length,
        tokens: sumWhere(calls, (call) => call.day === day),
      });
    }
  }
);

const LoopCalls = Schema.Array(
  Schema.Struct({
    key: Schema.Literals(["t1", "t2", "t3"]),
    run: Schema.Literals(["a", "b"]),
    tokens: Schema.Literals([0, 29_000, 149_999, 150_000, 200_000]),
  })
).check(Schema.isMaxLength(30));

it.prop(
  "a repeat warning fires once per run and key at the third call, a call warning once per run at the first call of 150k or more, and nothing else fires",
  { calls: LoopCalls },
  ({ calls }) => {
    const storage = nodeSqlStorage(":memory:");
    const seen = new Map<string, number>();
    const big = new Set<string>();

    for (const { key, run, tokens } of calls) {
      const slot = `${run}/${key}`;
      const count = (seen.get(slot) ?? 0) + 1;
      seen.set(slot, count);

      const result = tally(storage, "2026-10-16", run, key, tokens);

      const expected = [
        ...(count === 3 ? ["repeat"] : []),
        ...(tokens >= 150_000 && !big.has(run) ? ["call"] : []),
      ];

      if (tokens >= 150_000) {
        big.add(run);
      }

      expect(result.crossed.filter((line) => line !== "day")).toStrictEqual(
        expected
      );
    }
  },
  { arbitrary: { runs: 300, seed: "loop-think-warning" } }
);

it("four fan branches of about 29k in one run no longer warn", () => {
  const storage = nodeSqlStorage(":memory:");

  const crossed = ["t7", "t31", "t12", "t40"].flatMap(
    (key) => tally(storage, "2026-10-27", "w2d", key, 29_000).crossed
  );

  expect(crossed).toStrictEqual([]);
});

it("warning text names the signal, the run totals and the check line", () => {
  const storage = nodeSqlStorage(":memory:");
  tally(storage, "2026-10-27", "r", "think", 10);
  tally(storage, "2026-10-27", "r", "think", 10);
  const third = tally(storage, "2026-10-27", "r", "think", 160_000);

  expect(third.crossed).toStrictEqual(["repeat", "call"]);

  const repeat = warnText("repeat", "r", "think", third, "2026-10-27");
  const call = warnText("call", "r", "think", third, "2026-10-27");

  expect(repeat).toContain("step think has thought 3 times");
  expect(call).toContain("one call at state think used 160,000 tokens");
  expect(repeat).toContain("160,020 tokens over 3 calls");
  expect(call).toContain('inspectRun {"runId": "r"}');
  expect(dedupeKey("repeat", "d", "r", "think")).toBe("think-repeat:r:think");
  expect(dedupeKey("call", "d", "r", "think")).toBe("think-call:r");
});

const History = Schema.Array(Tokens).check(Schema.isMaxLength(14));

const dateAt = (index: number) => utcDay(Date.UTC(2026, 0, 1 + index * 2));

const medianOf = (sample: readonly number[]) => {
  if (sample.length === 0) {
    return null;
  }

  if (sample.length % 2 === 1) {
    return sample[(sample.length - 1) / 2] ?? 0;
  }

  return (
    ((sample[sample.length / 2 - 1] ?? 0) + (sample[sample.length / 2] ?? 0)) /
    2
  );
};

it.prop(
  "daily warnings exceed the floor or twice the trailing seven-data-day median exactly once per UTC day",
  {
    calls: Schema.Array(Tokens).check(Schema.isMaxLength(20)),
    future: Tokens,
    history: History,
  },
  ({ calls, future, history }) => {
    const storage = nodeSqlStorage(":memory:");

    for (const [index, tokens] of history.entries()) {
      tally(storage, dateAt(index), `history-${index}`, "think", tokens);
    }

    tally(storage, "2027-01-01", "future", "think", future);

    const preceding = [...history];

    for (const index of [history.length, history.length + 1]) {
      const day = dateAt(index);
      const sample = preceding.slice(-7).toSorted((a, b) => a - b);
      const median = medianOf(sample);

      const line = Math.max(1_500_000, 2 * (median ?? 0));
      let total = 0;
      let warned = false;
      let warnings = 0;

      for (const tokens of [0, line, 0, 1, ...calls, line]) {
        total += tokens;
        const expected = !warned && total > line;
        const result = tally(storage, day, "current", "think", tokens);

        expect(result.crossed.includes("day")).toBe(expected);
        expect(result.day.tokens).toBe(total);

        if (result.crossed.includes("day")) {
          expect(result.dayWarning).toStrictEqual({
            line,
            median,
            multiple: 2,
            sampleDays: sample.length,
          });
          warnings += 1;
          warned = true;
          const message = warnText("day", "current", "think", result, day);
          expect(message).toContain("inspectRun on the busiest runs");
          expect(message).toContain("no run is held");
          expect(message).toContain(
            JSON.stringify({
              calls: result.day.calls,
              day,
              line,
              median,
              multiple: 2,
              sampleDays: sample.length,
              tokens: total,
            })
          );
        }
      }

      expect(warnings).toBe(1);
      preceding.push(total);
    }
  },
  { arbitrary: { runs: 200, seed: "daily-think-warning" } }
);
