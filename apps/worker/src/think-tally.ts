import type { SqlStorage } from "@mischief/plan-run";
import { DateTime, Option, Schema } from "effect";

export const DAY_WARN_TOKENS = 1_500_000;

export const RUN_WARN_TOKENS = 100_000;

const DAYS =
  "CREATE TABLE IF NOT EXISTS mischief_think_days (day TEXT PRIMARY KEY, calls INTEGER NOT NULL, tokens INTEGER NOT NULL)";

const RUNS =
  "CREATE TABLE IF NOT EXISTS mischief_think_runs (run_id TEXT PRIMARY KEY, calls INTEGER NOT NULL, tokens INTEGER NOT NULL)";

const Totals = Schema.Struct({ calls: Schema.Finite, tokens: Schema.Finite });

const totalsOf = (rows: readonly Readonly<Record<string, SqlStorageValue>>[]) =>
  Option.getOrElse(
    Option.fromNullishOr(rows[0]).pipe(
      Option.flatMap(Schema.decodeUnknownOption(Totals))
    ),
    () => ({ calls: 0, tokens: 0 })
  );

export type Crossing = "day" | "run";

export interface Tallied {
  readonly crossed: readonly Crossing[];
  readonly day: { readonly calls: number; readonly tokens: number };
  readonly run: { readonly calls: number; readonly tokens: number };
}

const crossedAt = (before: number, after: number, line: number) =>
  before < line && after >= line;

export const tally = (
  storage: SqlStorage,
  day: string,
  runId: string,
  tokens: number
): Tallied =>
  storage.transactionSync(() => {
    storage.sql.exec(DAYS);
    storage.sql.exec(RUNS);

    const dayBefore = totalsOf(
      storage.sql
        .exec(
          "SELECT calls, tokens FROM mischief_think_days WHERE day = ?",
          day
        )
        .toArray()
    );

    const runBefore = totalsOf(
      storage.sql
        .exec(
          "SELECT calls, tokens FROM mischief_think_runs WHERE run_id = ?",
          runId
        )
        .toArray()
    );

    storage.sql.exec(
      "INSERT INTO mischief_think_days (day, calls, tokens) VALUES (?, 1, ?) ON CONFLICT (day) DO UPDATE SET calls = calls + 1, tokens = tokens + excluded.tokens",
      day,
      tokens
    );

    storage.sql.exec(
      "INSERT INTO mischief_think_runs (run_id, calls, tokens) VALUES (?, 1, ?) ON CONFLICT (run_id) DO UPDATE SET calls = calls + 1, tokens = tokens + excluded.tokens",
      runId,
      tokens
    );

    const dayAfter = {
      calls: dayBefore.calls + 1,
      tokens: dayBefore.tokens + tokens,
    };

    const runAfter = {
      calls: runBefore.calls + 1,
      tokens: runBefore.tokens + tokens,
    };

    return {
      crossed: [
        ...(crossedAt(dayBefore.tokens, dayAfter.tokens, DAY_WARN_TOKENS)
          ? ["day" as const]
          : []),
        ...(crossedAt(runBefore.tokens, runAfter.tokens, RUN_WARN_TOKENS)
          ? ["run" as const]
          : []),
      ],
      day: dayAfter,
      run: runAfter,
    };
  });

export const dayTotals = (storage: SqlStorage, day: string) => {
  storage.sql.exec(DAYS);

  return totalsOf(
    storage.sql
      .exec("SELECT calls, tokens FROM mischief_think_days WHERE day = ?", day)
      .toArray()
  );
};

export const utcDay = (millis: number) =>
  DateTime.formatIsoDateUtc(DateTime.makeUnsafe(millis));

export const warnText = (
  crossing: Crossing,
  runId: string,
  key: string,
  { day, run }: Pick<Tallied, "day" | "run">,
  today: string
) =>
  crossing === "day"
    ? [
        `Mischief think telemetry: ${today} (UTC) has passed ${DAY_WARN_TOKENS.toLocaleString("en-US")} tokens: ${day.tokens.toLocaleString("en-US")} over ${day.calls} calls, last at ${runId} state ${key}.`,
        "This is a warning only; no run is held.",
        "",
        JSON.stringify({
          calls: day.calls,
          day: today,
          line: DAY_WARN_TOKENS,
          tokens: day.tokens,
        }),
        "",
        "Check: inspectRun on the busiest runs, and the mischief-celld meter in the cliproxy dashboard.",
      ].join("\n")
    : [
        `Mischief think telemetry: run ${runId} has passed ${RUN_WARN_TOKENS.toLocaleString("en-US")} tokens: ${run.tokens.toLocaleString("en-US")} over ${run.calls} calls, last at state ${key}.`,
        "This is a warning only; the run continues.",
        "",
        JSON.stringify({
          calls: run.calls,
          line: RUN_WARN_TOKENS,
          runId,
          tokens: run.tokens,
        }),
        "",
        `Check: inspectRun {"runId": "${runId}"} for a loop; abortRun stops it if it is one.`,
      ].join("\n");
