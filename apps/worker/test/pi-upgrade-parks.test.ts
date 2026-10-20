// @effect-diagnostics asyncFunction:off -- esbuild compiles the real Worker with a test-only observation wrapper around its SQLite opener.
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { RunReportSchema, RunStateSchema } from "@mischief/core";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { build } from "esbuild";

import { kill, post, prepare, start } from "./workerd.js";
import type { Workerd } from "./workerd.js";

const KINDS = ["ask", "shadow-judge"] as const;

const planOf = (kind: (typeof KINDS)[number], thenThink: boolean) => {
  const afterReply = thenThink ? "first" : "done";

  const states = {
    done: { type: "final" },
    wait:
      kind === "ask"
        ? {
            meta: {
              step: {
                kind: "ask",
                message: "send the answer",
                to: "desk/answer",
                writes: "reply",
              },
            },
            on: { replied: { target: afterReply } },
          }
        : {
            meta: { step: { kind: "judge", question: "Continue?" } },
            on: { go: { target: afterReply }, stop: { target: "done" } },
          },
  };

  const thinking = {
    first: {
      meta: { step: { kind: "think", prompt: "first", writes: "first" } },
      on: { done: { target: "second" } },
    },
    second: {
      meta: { step: { kind: "think", prompt: "second", writes: "second" } },
      on: { done: { target: "done" } },
    },
  };

  return {
    defaults: { agent: { model: "sol" } },
    envelope: {
      maxAgents: 2,
      maxDepth: 3,
      maxSteps: 10,
      maxThinking: "low",
      models: ["sol"],
      names: ["desk/answer"],
      thresholds: { judge: 0.8 },
    },
    goal: "Wait for a reply without opening a thinking store",
    id: "waiting",
    machine: {
      id: "waiting",
      initial: "wait",
      states: thenThink ? { ...states, ...thinking } : states,
    },
  };
};

const AuditSchema = Schema.Struct({
  failedNotices: Schema.Array(Schema.Struct({ key: Schema.String })),
  opens: Schema.Array(Schema.Struct({ count: Schema.Int })),
  runs: Schema.Array(
    Schema.Struct({ state: Schema.fromJsonString(RunStateSchema) })
  ),
  versions: Schema.Array(Schema.Struct({ version: Schema.Int })),
});

const audit = (world: Workerd, runId: string) =>
  post(world, "upgradeInspect", { runId }).pipe(
    Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(AuditSchema)(body))
  );

const report = (world: Workerd, runId: string) =>
  post(world, "inspectRun", { runId }).pipe(
    Effect.flatMap(({ body }) =>
      Schema.decodeUnknownEffect(RunReportSchema)(body)
    )
  );

const fixtureBundle = Effect.gen(function* compileProof() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const bundle = path.join(
    yield* fs.makeTempDirectoryScoped(),
    "upgrade-proof-worker.js"
  );

  const observer = path.resolve(
    import.meta.dirname,
    "fixtures/observed-pi-storage.ts"
  );

  const productionObject = path.resolve(
    import.meta.dirname,
    "../src/plan-run-object.ts"
  );

  yield* Effect.tryPromise(
    async () =>
      await build({
        bundle: true,
        conditions: ["workerd", "worker", "browser", "import"],
        entryPoints: [
          path.resolve(import.meta.dirname, "fixtures/upgrade-proof-worker.ts"),
        ],
        external: ["cloudflare:*"],
        format: "esm",
        mainFields: ["module", "main"],
        outfile: bundle,
        platform: "neutral",
        plugins: [
          {
            name: "observe-production-pi-storage",
            setup(builder) {
              builder.onResolve(
                {
                  filter:
                    // oxlint-disable-next-line eslint/require-unicode-regexp -- esbuild sends this filter to Go, whose regexp parser rejects the u flag.
                    /^@earendil-works\/pi-durable\/storage\/sqlite\/cloudflare$/,
                },
                ({ importer }) =>
                  importer === productionObject ? { path: observer } : undefined
              );
            },
          },
        ],
      })
  );

  return bundle;
});

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

it.live.prop(
  "ask and shadow-judge waits survive N object reopens and drives unchanged without a failure notice or SQLite migration; only a think after the reply opens the store, once",
  {
    reopens: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })),
  },
  ({ reopens }) =>
    Effect.gen(function* parkedPlanIsNotParkedThink() {
      const bundle = yield* fixtureBundle;
      const world = yield* prepare(30_000, [], undefined, { bundle });
      let process = yield* start(world);

      for (const kind of KINDS) {
        for (const thenThink of [false, true]) {
          const runId = `${kind}-${thenThink ? "think" : "done"}`;
          const seeded = yield* post(world, "upgradeSeed", { runId });

          expect(seeded.status).toBe(200);

          const submitted = yield* post(world, "submitPlan", {
            judge: "shadow",
            plan: planOf(kind, thenThink),
            runId,
          });

          expect(
            submitted.status,
            `${runId}: ${JSON.stringify(submitted.body)}`
          ).toBe(200);

          const waiting = yield* report(world, runId);
          const initial = yield* audit(world, runId);
          const checkpoint = initial.runs[0]?.state.checkpoint;

          expect(waiting.status).toBe("waiting-for-reply");
          expect(waiting.awaiting).toHaveLength(1);
          expect(waiting.failures ?? []).toStrictEqual([]);
          expect(initial.runs).toHaveLength(1);
          expect(checkpoint).toBeDefined();
          expect(checkpoint).not.toBeNull();
          expect(initial.failedNotices).toStrictEqual([]);
          expect(initial.opens).toStrictEqual([{ count: 0 }]);
          expect(initial.versions).toStrictEqual([{ version: 1 }]);

          for (let reopen = 0; reopen < reopens; reopen += 1) {
            yield* kill(process);
            process = yield* start(world);

            const inspected = yield* report(world, runId);

            expect(inspected.status).toBe("waiting-for-reply");
            expect(inspected.awaiting).toStrictEqual(waiting.awaiting);

            yield* post(world, "resumeRun", { runId });

            const driven = yield* report(world, runId);
            const stored = yield* audit(world, runId);

            expect(driven.status).toBe("waiting-for-reply");
            expect(driven.awaiting).toStrictEqual(waiting.awaiting);
            expect(driven.failures ?? []).toStrictEqual([]);
            expect(driven.docs).toStrictEqual(waiting.docs);
            expect(stored.runs[0]?.state.checkpoint).toStrictEqual(checkpoint);
            expect(stored.failedNotices).toStrictEqual([]);
            expect(stored.opens).toStrictEqual([{ count: 0 }]);
            expect(stored.versions).toStrictEqual([{ version: 1 }]);
          }

          const replied = yield* post(world, "deliverReply", {
            body: kind === "ask" ? "answer" : '{"choice":"go"}',
            from: kind === "ask" ? "desk/answer" : "shadow/judge",
            replyTo: waiting.awaiting?.[0]?.messageId ?? "missing",
          });

          expect(replied.status, JSON.stringify(replied.body)).toBe(200);

          const done = yield* report(world, runId);
          const migrated = yield* audit(world, runId);

          expect(done.status).toBe("done");
          expect(done.failures ?? []).toStrictEqual([]);
          expect(migrated.failedNotices).toStrictEqual([]);
          expect(migrated.opens).toStrictEqual([{ count: thenThink ? 1 : 0 }]);
          expect(migrated.versions).toStrictEqual([
            { version: thenThink ? 2 : 1 },
          ]);

          if (thenThink) {
            expect(done.docs.first).toBe("faux answer to: first");
            expect(done.docs.second).toBe("faux answer to: second");
          }

          yield* kill(process);
          process = yield* start(world);

          const replay = yield* report(world, runId);
          const retained = yield* audit(world, runId);

          expect(replay.status).toBe("done");
          expect(replay.docs).toStrictEqual(done.docs);
          expect(retained.failedNotices).toStrictEqual([]);
          expect(retained.opens).toStrictEqual(migrated.opens);
          expect(retained.versions).toStrictEqual(migrated.versions);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(services)),
  { arbitrary: { runs: 6 }, timeout: 180_000 }
);
