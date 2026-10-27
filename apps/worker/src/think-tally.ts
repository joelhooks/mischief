import type { SqlStorage } from "@mischief/plan-run";
import { DateTime, Option, Schema } from "effect";

export const DAY_WARN_FLOOR_TOKENS = 1_500_000;

export const DAY_WARN_HISTORY_DAYS = 7;

export const DAY_WARN_MEDIAN_MULTIPLE = 2;

export const RUN_WARN_CALL_TOKENS = 150_000;

export const RUN_WARN_STEP_REPEATS = 3;

const DAYS =
  "CREATE TABLE IF NOT EXISTS mischief_think_days (day TEXT PRIMARY KEY, calls INTEGER NOT NULL, tokens INTEGER NOT NULL)";

const RUNS =
  "CREATE TABLE IF NOT EXISTS mischief_think_runs (run_id TEXT PRIMARY KEY, calls INTEGER NOT NULL, tokens INTEGER NOT NULL)";

const STEPS =
  "CREATE TABLE IF NOT EXISTS mischief_think_steps (run_id TEXT NOT NULL, key TEXT NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY (run_id, key))";

const BIG_CALLS =
  "CREATE TABLE IF NOT EXISTS mischief_think_big_calls (run_id TEXT PRIMARY KEY)";

const Totals = Schema.Struct({ calls: Schema.Finite, tokens: Schema.Finite });

const totalsOf = (rows: readonly Readonly<Record<string, SqlStorageValue>>[]) =>
  Option.getOrElse(
    Option.fromNullishOr(rows[0]).pipe(
      Option.flatMap(Schema.decodeUnknownOption(Totals))
    ),
    () => ({ calls: 0, tokens: 0 })
  );

export type Crossing = "call" | "day" | "repeat";

export interface Tallied {
  readonly crossed: readonly Crossing[];
  readonly day: { readonly calls: number; readonly tokens: number };
  readonly dayWarning: ReturnType<typeof dayWarning>;
  readonly run: { readonly calls: number; readonly tokens: number };
  readonly step: { readonly calls: number };
  readonly tokens: number;
}

export const dedupeKey = (
  crossing: Crossing,
  day: string,
  runId: string,
  key: string
) =>
  ({
    call: `think-call:${runId}`,
    day: `think-day:${day}`,
    repeat: `think-repeat:${runId}:${key}`,
  })[crossing];

export const dayWarning = (storage: SqlStorage, day: string) => {
  storage.sql.exec(DAYS);

  const history = Schema.decodeUnknownSync(Schema.Array(Totals))(
    storage.sql
      .exec(
        "SELECT calls, tokens FROM mischief_think_days WHERE day < ? ORDER BY day DESC LIMIT ?",
        day,
        DAY_WARN_HISTORY_DAYS
      )
      .toArray()
  );

  const ordered = history.map(({ tokens }) => tokens).toSorted((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);

  const median =
    ordered.length === 0
      ? null
      : ((ordered[middle - (ordered.length % 2 === 0 ? 1 : 0)] ?? 0) +
          (ordered[middle] ?? 0)) /
        2;

  return {
    line: Math.max(
      DAY_WARN_FLOOR_TOKENS,
      DAY_WARN_MEDIAN_MULTIPLE * (median ?? 0)
    ),
    median,
    multiple: DAY_WARN_MEDIAN_MULTIPLE,
    sampleDays: history.length,
  };
};

export const tally = (
  storage: SqlStorage,
  day: string,
  runId: string,
  key: string,
  tokens: number
): Tallied =>
  storage.transactionSync(() => {
    storage.sql.exec(DAYS);
    storage.sql.exec(RUNS);
    storage.sql.exec(STEPS);
    storage.sql.exec(BIG_CALLS);

    const warning = dayWarning(storage, day);

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

    storage.sql.exec(
      "INSERT INTO mischief_think_steps (run_id, key, calls) VALUES (?, ?, 1) ON CONFLICT (run_id, key) DO UPDATE SET calls = calls + 1",
      runId,
      key
    );

    const stepCalls = totalsOf(
      storage.sql
        .exec(
          "SELECT calls, 0 AS tokens FROM mischief_think_steps WHERE run_id = ? AND key = ?",
          runId,
          key
        )
        .toArray()
    ).calls;

    const bigCall =
      tokens >= RUN_WARN_CALL_TOKENS &&
      storage.sql
        .exec(
          "INSERT OR IGNORE INTO mischief_think_big_calls (run_id) VALUES (?) RETURNING run_id",
          runId
        )
        .toArray().length > 0;

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
        ...(dayBefore.tokens <= warning.line && dayAfter.tokens > warning.line
          ? ["day" as const]
          : []),
        ...(stepCalls === RUN_WARN_STEP_REPEATS ? ["repeat" as const] : []),
        ...(bigCall ? ["call" as const] : []),
      ],
      day: dayAfter,
      dayWarning: warning,
      run: runAfter,
      step: { calls: stepCalls },
      tokens,
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
  {
    day,
    dayWarning: warning,
    run,
    step,
    tokens,
  }: Pick<Tallied, "day" | "dayWarning" | "run" | "step" | "tokens">,
  today: string
) => {
  if (crossing === "day") {
    return [
      `Mischief think telemetry: ${today} (UTC) has passed ${warning.line.toLocaleString("en-US")} tokens: ${day.tokens.toLocaleString("en-US")} over ${day.calls} calls, last at ${runId} state ${key}.`,
      `Daily line: max(${DAY_WARN_FLOOR_TOKENS.toLocaleString("en-US")} floor, ${warning.multiple} × trailing median ${warning.median?.toLocaleString("en-US") ?? "unavailable (no history)"} tokens from ${warning.sampleDays} earlier days with data, up to ${DAY_WARN_HISTORY_DAYS}).`,
      "This is a warning only; no run is held.",
      "",
      JSON.stringify({
        calls: day.calls,
        day: today,
        ...warning,
        tokens: day.tokens,
      }),
      "",
      "Check: inspectRun on the busiest runs, and the mischief-celld meter in the cliproxy dashboard.",
    ].join("\n");
  }

  const signal =
    crossing === "repeat"
      ? `step ${key} has thought ${step.calls} times`
      : `one call at state ${key} used ${tokens.toLocaleString("en-US")} tokens`;

  return [
    `Mischief think telemetry: run ${runId}: ${signal}. Run totals: ${run.tokens.toLocaleString("en-US")} tokens over ${run.calls} calls.`,
    "This is a warning only; the run continues.",
    "",
    JSON.stringify({
      callTokens: tokens,
      calls: run.calls,
      runId,
      signal: crossing,
      state: key,
      stepCalls: step.calls,
      tokens: run.tokens,
    }),
    "",
    `Check: inspectRun {"runId": "${runId}"} for a loop; abortRun stops it if it is one.`,
  ].join("\n");
};
