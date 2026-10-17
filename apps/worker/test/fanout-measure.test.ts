// @effect-diagnostics nodeBuiltinImport:off -- the measurement bundles a metered worker with esbuild and samples the workerd child's RSS with ps; both are child processes Effect does not wrap synchronously.
import { execFileSync } from "node:child_process";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Clock,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";

import { getJson, post, prepare, start } from "./workerd.js";
import type { Workerd } from "./workerd.js";

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

const MEASURING = process.env.MISCHIEF_MEASURE === "1";

const listOr = (text: string | undefined, fallback: readonly number[]) =>
  text === undefined || text === ""
    ? fallback
    : text.split(",").map((part) => Number(part.trim()));

const WIDTHS = listOr(
  process.env.MISCHIEF_MEASURE_WIDTHS,
  [25, 50, 100, 200, 400]
);

const OUTPUTS = listOr(process.env.MISCHIEF_MEASURE_OUTPUTS, [1024, 8192]);

const ECHO_PREFIX = "faux answer to: ";

const MEASURE_PATH = "/__measure";

const branchOf = (index: number) => ({
  initial: "think",
  states: {
    done: { type: "final" },
    think: {
      meta: {
        step: {
          kind: "think",
          prompt: "{{docs.seed}}",
          writes: `out_${index}`,
        },
      },
      on: { done: { target: "done" } },
    },
  },
});

const fanoutPlan = (width: number) => ({
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: width,
    maxDepth: 3,
    maxSteps: width + 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: `Think ${width} times at once`,
  id: "fanout",
  machine: {
    id: "fanout",
    initial: "fan",
    states: {
      done: { type: "final" },
      fan: {
        meta: {
          step: {
            branches: Object.fromEntries(
              Array.from({ length: width }, (_, index) => [
                `b${index}`,
                branchOf(index),
              ])
            ),
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: { done: { target: "done" } },
      },
    },
  },
});

const CommitSchema = Schema.Struct({
  bytes: Schema.Finite,
  kind: Schema.String,
  largestValue: Schema.Finite,
  refused: Schema.NullOr(Schema.String),
  statements: Schema.Finite,
  tables: Schema.Record(Schema.String, Schema.Finite),
});

const RunStatePartsSchema = Schema.Struct({
  mailbox: Schema.Finite,
  mailboxEvents: Schema.Finite,
  pending: Schema.Finite,
  snapshot: Schema.Finite,
  state: Schema.Finite,
});

const MeasuredSchema = Schema.Struct({
  commits: Schema.Array(CommitSchema),
  runStates: Schema.Array(RunStatePartsSchema),
});

const ReportSchema = Schema.Struct({
  docs: Schema.Record(Schema.String, Schema.Json),
  status: Schema.String,
});

const rssKib = (pid: number) =>
  Effect.sync(() => {
    try {
      return Number(
        execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
          encoding: "utf-8",
        }).trim()
      );
    } catch {
      return 0;
    }
  });

const bundleMeteredWorker = (into: string) =>
  Effect.gen(function* bundle() {
    const path = yield* Path.Path;
    const app = path.resolve(import.meta.dirname, "..");
    const outfile = path.join(into, "metered-worker.js");

    yield* Effect.sync(() =>
      execFileSync(
        path.join(app, "node_modules", ".bin", "esbuild"),
        [
          "test/measure/worker.ts",
          "--bundle",
          "--format=esm",
          "--platform=neutral",
          "--main-fields=module,main",
          "--conditions=workerd,worker,browser,import",
          "--external:cloudflare:*",
          "--external:node:*",
          `--outfile=${outfile}`,
          "--log-level=warning",
          "--define:__BUNDLE_COMMIT__='measure'",
          "--define:__BUNDLE_VERSION__='measure'",
        ],
        { cwd: app }
      )
    );

    return outfile;
  });

const sum = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0);

const largest = (values: readonly number[]) => Math.max(0, ...values);

const isMischief = (tables: Readonly<Record<string, number>>) =>
  Object.keys(tables).some((name) => name.startsWith("mischief_"));

const takeMeasured = (world: Workerd) =>
  getJson(world, MEASURE_PATH).pipe(
    Effect.flatMap(({ body }) =>
      Schema.decodeUnknownEffect(MeasuredSchema)(body)
    )
  );

const meteredWorld = (bundle: string) =>
  Effect.gen(function* startMetered() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const world = yield* prepare(600_000);

    yield* fs.copyFile(bundle, path.join(world.dir, "worker.js"));

    const child = yield* start(world);

    yield* takeMeasured(world);

    return { pid: child.pid ?? 0, world };
  });

const statusOf = (status: number, body: Schema.Json) =>
  Option.match(Schema.decodeUnknownOption(ReportSchema)(body), {
    onNone: () => `http ${status}`,
    onSome: (report) => report.status,
  });

const firstRefusal = (commits: readonly (typeof CommitSchema.Type)[]) =>
  commits.flatMap(({ refused }) => (refused === null ? [] : [refused]))[0] ??
  null;

const measure = (bundle: string, width: number, output: number) =>
  Effect.gen(function* measureOne() {
    const { pid, world } = yield* meteredWorld(bundle);
    const peak = yield* Ref.make(yield* rssKib(pid));

    yield* rssKib(pid).pipe(
      Effect.flatMap((rss) => Ref.update(peak, (top) => Math.max(top, rss))),
      Effect.andThen(Effect.sleep("100 millis")),
      Effect.forever,
      Effect.forkScoped
    );

    const began = yield* Clock.currentTimeMillis;

    const submitted = yield* post(world, "submitPlan", {
      docs: { seed: "x".repeat(output - ECHO_PREFIX.length) },
      plan: fanoutPlan(width),
      runId: `fanout-${width}-${output}`,
    });

    const ended = yield* Clock.currentTimeMillis;
    const { commits, runStates } = yield* takeMeasured(world);

    const table = (name: string) =>
      sum(commits.map(({ tables }) => tables[name] ?? 0));

    const run = commits.filter(({ tables }) => isMischief(tables));

    return {
      commits: run.length,
      docBytes: table("mischief_docs"),
      journalBytes: table("mischief_journal"),
      largestValue: largest(run.map(({ largestValue }) => largestValue)),
      maxCommit: largest(run.map(({ bytes }) => bytes)),
      maxMailboxEvents: largest(
        runStates.map(({ mailboxEvents }) => mailboxEvents)
      ),
      maxSnapshot: largest(runStates.map(({ snapshot }) => snapshot)),
      output,
      peakRssMib: Math.round((yield* Ref.get(peak)) / 1024),
      refused: firstRefusal(commits),
      runStateBytes: table("mischief_runs"),
      runStateWrites: runStates.length,
      seconds: (ended - began) / 1000,
      status: statusOf(submitted.status, submitted.body),
      thinkingBytes: sum(
        commits.flatMap(({ bytes, tables }) =>
          isMischief(tables) ? [] : [bytes]
        )
      ),
      thinkingCommits: commits.length - run.length,
      totalBytes: sum(commits.map(({ bytes }) => bytes)),
      width,
    };
  }).pipe(Effect.scoped);

type Measurement = Effect.Success<ReturnType<typeof measure>>;

const kib = (bytes: number) => (bytes / 1024).toFixed(0);

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

const sweepTable = (rows: readonly Measurement[]) =>
  [
    "| N | output | outcome | run commits | max commit KiB | largest row KiB | max snapshot KiB | max unconsumed | run-state writes | run-state MiB | journal KiB | docs KiB | thinking commits | thinking KiB | total MiB | peak RSS MiB | seconds |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows
      .map((row) =>
        [
          row.width,
          `${kib(row.output)} KiB`,
          row.refused === null ? row.status : `${row.status}: ${row.refused}`,
          row.commits,
          kib(row.maxCommit),
          kib(row.largestValue),
          kib(row.maxSnapshot),
          row.maxMailboxEvents,
          row.runStateWrites,
          mib(row.runStateBytes),
          kib(row.journalBytes),
          kib(row.docBytes),
          row.thinkingCommits,
          kib(row.thinkingBytes),
          mib(row.totalBytes),
          row.peakRssMib,
          row.seconds.toFixed(1),
        ].join(" | ")
      )
      .map((line) => `| ${line} |`),
  ].join("\n");

const WALL_PLAN = {
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: 1,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Probe the commit wall",
  id: "wall",
  machine: {
    id: "wall",
    initial: "think",
    states: {
      done: { type: "final" },
      think: {
        meta: { step: { kind: "think", prompt: "once", writes: "thought" } },
        on: { done: { target: "done" } },
      },
    },
  },
};

const MIB = 1024 * 1024;

const WALL_PROBES = [
  ...[2, 3.5, 3.999, 4, 8, 12].map((size) => ({ docs: 1, size })),
  ...[8, 12, 16, 32, 64].map((size) => ({ docs: size, size })),
];

const probeWall = (world: Workerd, docs: number, size: number) =>
  Effect.gen(function* probe() {
    const each = Math.floor((size * MIB) / docs);

    const submitted = yield* post(world, "submitPlan", {
      docs: Object.fromEntries(
        Array.from({ length: docs }, (_, index) => [
          `seed_${index}`,
          "x".repeat(each),
        ])
      ),
      plan: WALL_PLAN,
      runId: `wall-${docs}-${String(size).replace(".", "-")}`,
    });

    const { commits } = yield* takeMeasured(world);

    return {
      docs,
      each,
      maxCommit: largest(commits.map(({ bytes }) => bytes)),
      refused: firstRefusal(commits),
      size,
      status: statusOf(submitted.status, submitted.body),
    };
  });

const wallTable = (
  rows: readonly Effect.Success<ReturnType<typeof probeWall>>[]
) =>
  [
    "| docs | bytes each | commit MiB | outcome |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.docs} | ${row.each} | ${mib(row.maxCommit)} | ${row.refused === null ? row.status : `${row.status}: ${row.refused}`} |`
    ),
  ].join("\n");

const reportPath = Path.Path.use(({ resolve }) =>
  Effect.succeed((name: string) =>
    resolve(import.meta.dirname, "..", "dist", name)
  )
);

const writeReport = (name: string, text: string) =>
  Effect.gen(function* write() {
    const fs = yield* FileSystem.FileSystem;
    const file = (yield* reportPath)(name);

    yield* fs.writeFileString(file, `${text}\n`);
    yield* Effect.logInfo(`${text}\n\nwritten to ${file}`);
  });

const meteredBundle = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped()
).pipe(Effect.flatMap(bundleMeteredWorker));

it.live.skipIf(!MEASURING)(
  "measures commit bytes, write amplification, RSS and wall time of one wide parallel think step",
  () =>
    Effect.gen(function* sweep() {
      const bundle = yield* meteredBundle;

      const rows = yield* Effect.forEach(
        OUTPUTS.flatMap((output) => WIDTHS.map((width) => ({ output, width }))),
        ({ output, width }) =>
          measure(bundle, width, output).pipe(
            Effect.tap((row) => Effect.logInfo(sweepTable([row])))
          )
      );

      yield* writeReport("fanout-measure.md", sweepTable(rows));

      expect(rows).toHaveLength(WIDTHS.length * OUTPUTS.length);
    }).pipe(Effect.scoped, Effect.provide(services)),
  3_600_000
);

it.live.skipIf(!MEASURING)(
  "finds the commit size SQLite refuses on workerd, for one big row and for many small ones",
  () =>
    Effect.gen(function* wall() {
      const bundle = yield* meteredBundle;
      const { world } = yield* meteredWorld(bundle);

      const rows = yield* Effect.all(
        WALL_PROBES.map(({ docs, size }) => probeWall(world, docs, size))
      );

      yield* writeReport("fanout-wall.md", wallTable(rows));

      expect(rows).toHaveLength(WALL_PROBES.length);
    }).pipe(Effect.scoped, Effect.provide(services)),
  600_000
);
