import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { build } from "esbuild";

import { getJson, kill, post, prepare, start } from "./workerd.js";

const branch = (refs: readonly string[], writes: string) => ({
  initial: "count",
  states: {
    count: {
      meta: {
        step: {
          capability: "count-refs",
          input: { refs },
          kind: "call",
          writes,
        },
      },
      on: { done: { target: "end" } },
    },
    end: { type: "final" },
  },
});

const plan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 20,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Count invented citation references in parallel",
  id: "counts",
  machine: {
    id: "counts",
    initial: "both",
    states: {
      both: {
        meta: {
          step: {
            branches: {
              left: branch(["cite-a", "cite-b"], "left-count"),
              right: branch(["cite-c"], "right-count"),
            },
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: { done: { target: "end" } },
      },
      end: { type: "final" },
    },
  },
};

const Report = Schema.Struct({
  docs: Schema.Record(Schema.String, Schema.Json),
  status: Schema.String,
});

const Revision = Schema.Struct({
  live: Schema.Array(Schema.String),
  reused: Schema.Array(Schema.String),
  run: Report,
});

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

for (const bundled of [false, true]) {
  it.live(
    `a ${bundled ? "bundled package" : "source"} consumer registers calls in parallel, stores docs once, and replays after eviction without invoking them`,
    () =>
      Effect.gen(function* consumer() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const bundle = path.join(dir, "consumer.js");

        yield* Effect.tryPromise(
          // @effect-diagnostics-next-line asyncFunction:off -- esbuild exposes a Promise API.
          async () =>
            await build({
              alias: bundled
                ? {
                    "@mischief/worker": path.resolve(
                      import.meta.dirname,
                      "../bundle/dist/index.js"
                    ),
                  }
                : {},
              bundle: true,
              conditions: ["workerd", "worker", "browser", "import"],
              define: {
                __BUNDLE_COMMIT__: JSON.stringify("fixture"),
                __BUNDLE_VERSION__: JSON.stringify("fixture"),
              },
              entryPoints: [
                path.resolve(import.meta.dirname, "fixtures/call-worker.ts"),
              ],
              external: ["cloudflare:*"],
              format: "esm",
              mainFields: ["module", "main"],
              outfile: bundle,
              platform: "neutral",
            })
        );

        const world = yield* prepare(30_000, [], undefined, {
          bundle,
          stepKinds: "call",
        });

        const first = yield* start(world);

        const registration = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ duplicate: Schema.String, invalid: Schema.String })
        )((yield* getJson(world, "/__registration")).body);

        expect(registration.duplicate).toContain(
          'duplicate call capability "count-refs"'
        );
        expect(registration.invalid).toContain(
          "names must match ^[a-z][a-z0-9-]{0,63}$"
        );

        const submitted = yield* post(world, "submitPlan", {
          plan,
          runId: "counts",
        });

        expect(submitted.status).toBe(200);

        const report = yield* Schema.decodeUnknownEffect(Report)(
          submitted.body
        );

        expect(report.status).toBe("done");
        expect(report.docs).toMatchObject({
          "left-count": { count: 2 },
          "right-count": { count: 1 },
        });

        const calls = yield* getJson(world, "/__calls");

        expect(calls.body).toEqual(
          expect.arrayContaining([
            { epoch: 0, key: "both.left.count", runId: "counts", visit: 1 },
            { epoch: 0, key: "both.right.count", runId: "counts", visit: 1 },
          ])
        );
        expect(calls.body).toHaveLength(2);

        yield* kill(first);
        yield* start(world);

        const revised = yield* post(world, "reviseRun", {
          dryRun: false,
          plan,
          runId: "counts",
        });

        expect(revised.status).toBe(200);

        const replay = yield* Schema.decodeUnknownEffect(Revision)(
          revised.body
        );

        expect(replay.live).toEqual([]);
        expect(replay.reused).toHaveLength(2);
        expect(replay.run.status).toBe("done");
        expect(replay.run.docs).toEqual(report.docs);
        expect((yield* getJson(world, "/__calls")).body).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(services)),
    60_000
  );
}
