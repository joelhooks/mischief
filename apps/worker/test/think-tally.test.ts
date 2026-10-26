import { expect, it } from "@effect/vitest";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Schema } from "effect";

import {
  RUN_WARN_TOKENS,
  dayTotals,
  tally,
  utcDay,
  warnText,
} from "../src/think-tally.js";

const Tokens = Schema.Int.check(
  Schema.isBetween({ maximum: 6_000_000, minimum: 0 })
);

const Call = Schema.Struct({
  day: Schema.Literals(["2026-10-16", "2026-10-17"]),
  run: Schema.Literals(["a", "b", "c"]),
  tokens: Tokens,
});

const Calls = Schema.Array(Call).check(Schema.isMaxLength(40));

const sumWhere = (
  calls: readonly (typeof Call.Type)[],
  matches: (call: typeof Call.Type) => boolean
) => calls.filter(matches).reduce((total, { tokens }) => total + tokens, 0);

it.prop(
  "the run warning is crossed once per run and the stored day totals are the sums",
  { calls: Calls },
  ({ calls }) => {
    const storage = nodeSqlStorage(":memory:");

    const crossings = calls.flatMap(({ day, run, tokens }) =>
      tally(storage, day, run, tokens).crossed.flatMap((line) =>
        line === "run" ? [run] : []
      )
    );

    const days = [...new Set(calls.map(({ day }) => day))];
    const runs = [...new Set(calls.map(({ run }) => run))];

    const expected = runs.filter(
      (run) => sumWhere(calls, (call) => call.run === run) >= RUN_WARN_TOKENS
    );

    expect(crossings.toSorted()).toStrictEqual(expected.toSorted());

    for (const day of days) {
      expect(dayTotals(storage, day)).toStrictEqual({
        calls: calls.filter((call) => call.day === day).length,
        tokens: sumWhere(calls, (call) => call.day === day),
      });
    }
  }
);

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
      tally(storage, dateAt(index), `history-${index}`, tokens);
    }

    tally(storage, "2027-01-01", "future", future);

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
        const result = tally(storage, day, "current", tokens);

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
