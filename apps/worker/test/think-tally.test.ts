import { expect, it } from "@effect/vitest";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Schema } from "effect";

import {
  DAY_WARN_TOKENS,
  RUN_WARN_TOKENS,
  dayTotals,
  tally,
} from "../src/think-tally.js";

const Call = Schema.Struct({
  day: Schema.Literals(["2026-10-16", "2026-10-17"]),
  run: Schema.Literals(["a", "b", "c"]),
  tokens: Schema.Int.check(Schema.isBetween({ maximum: 400_000, minimum: 0 })),
});

const Calls = Schema.Array(Call).check(Schema.isMaxLength(40));

const sumWhere = (
  calls: readonly (typeof Call.Type)[],
  matches: (call: typeof Call.Type) => boolean
) => calls.filter(matches).reduce((total, { tokens }) => total + tokens, 0);

it.prop(
  "each warn line is crossed once per day and once per run, by the call that crosses it, and the totals are the sums",
  { calls: Calls },
  ({ calls }) => {
    const storage = nodeSqlStorage(":memory:");

    const crossings = calls.flatMap(({ day, run, tokens }) =>
      tally(storage, day, run, tokens).crossed.map((line) =>
        line === "day" ? `day:${day}` : `run:${run}`
      )
    );

    const days = [...new Set(calls.map(({ day }) => day))];
    const runs = [...new Set(calls.map(({ run }) => run))];

    const expected = [
      ...days.flatMap((day) =>
        sumWhere(calls, (call) => call.day === day) >= DAY_WARN_TOKENS
          ? [`day:${day}`]
          : []
      ),
      ...runs.flatMap((run) =>
        sumWhere(calls, (call) => call.run === run) >= RUN_WARN_TOKENS
          ? [`run:${run}`]
          : []
      ),
    ];

    expect(crossings.toSorted()).toStrictEqual(expected.toSorted());

    for (const day of days) {
      expect(dayTotals(storage, day)).toStrictEqual({
        calls: calls.filter((call) => call.day === day).length,
        tokens: sumWhere(calls, (call) => call.day === day),
      });
    }
  }
);
