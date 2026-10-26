// @effect-diagnostics asyncFunction:off -- esbuild builds the workerd fixture through its Promise API.
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { build } from "esbuild";

import { kill, post, prepare, start } from "./workerd.js";

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

const plan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 20,
    maxThinking: "low",
    models: ["sol"],
    names: ["sender/desk"],
    thresholds: { judge: 0.8 },
  },
  goal: "Keep a record, then judge it",
  id: "records",
  machine: {
    id: "records",
    initial: "ask",
    states: {
      ask: {
        meta: {
          step: {
            kind: "ask",
            message: "send the record",
            to: "sender/desk",
            writes: "record",
          },
        },
        on: { replied: { target: "judge" } },
      },
      end: { type: "final" },
      judge: {
        meta: { step: { kind: "judge", question: "Keep it?" } },
        on: { go: { target: "end" }, stop: { target: "end" } },
      },
    },
  },
};

const Awaiting = Schema.Struct({
  awaiting: Schema.Array(
    Schema.Struct({ messageId: Schema.String, to: Schema.String })
  ),
});

const Notice = Schema.Struct({ body: Schema.String, to: Schema.String });

const Notices = Schema.Array(
  Schema.Struct({ envelope: Schema.fromJsonString(Notice) })
);

it.live(
  "a reply survives a workerd crash between run journal and receipt, then gives one notice when its wake aborts",
  () =>
    Effect.gen(function* timedOut() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const bundle = path.join(
        yield* fs.makeTempDirectoryScoped(),
        "abort-worker.js"
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
              path.resolve(import.meta.dirname, "fixtures/abort-worker.ts"),
            ],
            external: ["cloudflare:*"],
            format: "esm",
            mainFields: ["module", "main"],
            outfile: bundle,
            platform: "neutral",
          })
      );

      const world = yield* prepare(1000, [], undefined, { bundle });
      const child = yield* start(world);

      const created = yield* post(world, "createSchedule", {
        every: "1 minute",
        maxWakes: 3,
        plan,
        scheduleId: "records",
        wakeTimeout: "1 minute",
      });

      expect(created.status).toBe(200);

      const waiting = (runId: string, to: string) =>
        post(world, "inspectRun", { runId }).pipe(
          Effect.flatMap(({ body }) =>
            Schema.decodeUnknownEffect(Awaiting)(body)
          ),
          Effect.filterOrFail(
            ({ awaiting }) => awaiting.some((ask) => ask.to === to),
            () => "the wake has not reached its ask"
          ),
          Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 200 })
        );

      const asks = yield* waiting("records-wake-1", "sender/desk");
      const ask = asks.awaiting.find(({ to }) => to === "sender/desk");
      expect(ask).toBeDefined();

      const deliver = HttpClientRequest.post(
        `http://127.0.0.1:${world.port}/test/reply`
      ).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          ask: ask?.messageId,
          objectName: `${world.driver.did}/records-wake-1`,
        })
      );

      yield* deliver.pipe(
        HttpClientRequest.setHeader("x-test-crash-after-journal", "true"),
        HttpClient.execute,
        Effect.flatMap((response) => response.text),
        Effect.tap((text) =>
          Effect.sync(() => {
            expect(text).toContain('"ok":false');
          })
        )
      );
      yield* kill(child);
      yield* start(world);
      yield* deliver.pipe(
        HttpClient.execute,
        Effect.flatMap((response) => response.text),
        Effect.tap((text) =>
          Effect.sync(() => {
            expect(text).toContain('"ok":true');
          })
        )
      );
      yield* waiting("records-wake-1", "shadow/judge");
      yield* post(world, "pauseRun", { runId: "records-wake-1" });

      yield* HttpClientRequest.post(
        `http://127.0.0.1:${world.port}/test/timeout`
      ).pipe(
        HttpClientRequest.setHeader(
          "x-test-schedule",
          `${world.driver.did}/records`
        ),
        HttpClient.execute,
        Effect.flatMap((response) => response.text)
      );

      const aborted = yield* post(world, "inspectRun", {
        runId: "records-wake-1",
      });

      expect(aborted.body).toMatchObject({
        docs: { record: "keep this record" },
        status: "aborted",
      });

      const readNotices = HttpClientRequest.get(
        `http://127.0.0.1:${world.port}/test/notices`
      ).pipe(
        HttpClient.execute,
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Notices))
      );

      yield* readNotices.pipe(
        Effect.filterOrFail(
          (notices) =>
            notices.some(({ envelope }) =>
              envelope.body.includes("Your reply reply-record reached")
            ),
          () => "the run alarm has not retried Postbox registration"
        ),
        Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 200 })
      );
      yield* post(world, "abortRun", {
        reason: "retried",
        runId: "records-wake-1",
      });
      yield* post(world, "abortRun", { runId: "records-wake-1" });

      const notices = yield* readNotices;

      const lost = notices.filter(({ envelope }) =>
        envelope.body.includes("Your reply reply-record reached")
      );

      expect(lost).toHaveLength(1);
      expect(lost[0]?.envelope).toMatchObject({ to: "sender/desk" });
      expect(lost[0]?.envelope.body).toContain("records-wake-1");
      expect(lost[0]?.envelope.body).toContain("wakeTimeout");
      expect(lost[0]?.envelope.body).toContain("before it finished");
      expect(lost[0]?.envelope.body).toContain(
        "Resend it as a reply to the next wake's ask"
      );
    }).pipe(Effect.scoped, Effect.provide(services)),
  60_000
);
