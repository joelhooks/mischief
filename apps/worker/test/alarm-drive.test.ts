// @effect-diagnostics asyncFunction:off -- esbuild and the killed client exercise native Promise/process boundaries.
// @effect-diagnostics nodeBuiltinImport:off -- the seam kills a real submitting client with SIGKILL; the process wrapper does not expose that signal.
import { spawn } from "node:child_process";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { build } from "esbuild";

import { bearer, kill, postStored, prepare, start } from "./workerd.js";

const plan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 1,
    maxDepth: 2,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "A killed client does not own execution",
  id: "alarm-client",
  machine: {
    id: "alarm-client",
    initial: "think",
    states: {
      end: { type: "final" },
      think: {
        meta: { step: { kind: "think", prompt: "work", writes: "work" } },
        on: { done: { target: "end" } },
      },
    },
  },
};

const Journal = Schema.Struct({
  journal: Schema.Array(
    Schema.Struct({ entry: Schema.Json, key: Schema.String })
  ),
});

const Report = Schema.Struct({
  docs: Schema.Record(Schema.String, Schema.Json),
  status: Schema.String,
});

const decodeReport = Schema.decodeUnknownSync(Report);

const decodeJournal = Schema.decodeUnknownSync(Journal);

const pendingAttempt = Schema.is(
  Schema.Struct({ pending: Schema.Literal(true) })
);

const decodeStored = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ status: Schema.String }))
);

const clientScript = `import { readFileSync } from "node:fs";
const { body, headers, url } = JSON.parse(readFileSync(0, "utf8"));
const response = await fetch(url, { body, headers, method: "POST" });
process.stdout.write((await response.text()) + "\\n");
setInterval(() => {}, 1000);
`;

it.live(
  "workerd finishes from the alarm after the submitting client is killed mid-think",
  () =>
    Effect.gen(function* killedClient() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const bundle = path.join(
        yield* fs.makeTempDirectoryScoped(),
        "alarm-worker.js"
      );

      yield* Effect.tryPromise(
        async () =>
          await build({
            bundle: true,
            conditions: ["workerd", "worker", "browser", "import"],
            define: {
              __BUNDLE_COMMIT__: JSON.stringify("fixture"),
              __BUNDLE_VERSION__: JSON.stringify("fixture"),
            },
            entryPoints: [
              path.resolve(import.meta.dirname, "fixtures/alarm-worker.ts"),
            ],
            external: ["cloudflare:*"],
            format: "esm",
            mainFields: ["module", "main"],
            outfile: bundle,
            platform: "neutral",
          })
      );
      const world = yield* prepare(1000, [], undefined, { bundle });
      yield* start(world);
      const authorization = yield* bearer(world.driver, "submitPlan");

      const child = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const process = spawn(
            "node",
            ["--input-type=module", "-e", clientScript],
            { stdio: ["pipe", "pipe", "pipe"] }
          );

          process.stdin.end(
            JSON.stringify({
              body: JSON.stringify({ plan, runId: "run" }),
              headers: { authorization, "content-type": "application/json" },
              url: `http://127.0.0.1:${world.port}/submitPlan`,
            })
          );

          return process;
        }),
        kill
      );

      const output: string[] = [];
      child.stdout.on("data", (data: Buffer) => {
        output.push(data.toString());
      });

      yield* postStored(world, "readRun", { runId: "run" }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          while: ({ body, status }) =>
            status !== 200 ||
            !decodeJournal(body).journal.some(
              ({ entry, key }) =>
                key.startsWith("think-attempt:") && pendingAttempt(entry)
            ),
        }),
        Effect.timeout("10 seconds")
      );

      const stored = yield* Effect.sync(() => output.join("")).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 millis"),
          while: (text) => !text.endsWith("\n"),
        }),
        Effect.timeout("1 second")
      );

      expect(decodeStored(stored).status).toBe("running");
      yield* kill(child);

      const mid = decodeReport(
        (yield* postStored(world, "inspectRun", { runId: "run" })).body
      );

      expect(mid.status).toBe("running");

      const finished = yield* postStored(world, "inspectRun", {
        runId: "run",
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          while: ({ body }) => decodeReport(body).status === "running",
        }),
        Effect.timeout("10 seconds")
      );

      expect(decodeReport(finished.body)).toEqual({
        docs: { work: "work finished" },
        status: "done",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
    ),
  30_000
);
