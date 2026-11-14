import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { PeonReport, PeonTombstone } from "@mischief/core";
import { Effect, Layer, Option, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { freshCaller, kill, post, prepare, start } from "./workerd.js";
import type { Workerd } from "./workerd.js";

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

const workspace = { repo: "example/project", sha: "a".repeat(40) };

const Calls = Schema.Array(
  Schema.Struct({ path: Schema.String, requestId: Schema.String })
);

const readCalls = (world: Workerd) =>
  HttpClient.get(`http://127.0.0.1:${world.boxPort}/__calls`).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Calls))
  );

const report = (world: Workerd) =>
  post(world, "inspectPeon", { peonId: "worker-a" }).pipe(
    Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(PeonReport)(body))
  );

const untilReport = (world: Workerd, state: string) =>
  report(world).pipe(
    Effect.filterOrFail(
      (value) => value.state === state && value.lastTurn !== null,
      () => "the stored turn is not complete yet"
    ),
    Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 200 })
  );

it.live(
  "a workerd eviction mid-prompt resumes the original request from its alarm without double accounting",
  () =>
    Effect.gen(function* eviction() {
      const world = yield* prepare(200, [], undefined, { peons: true });
      const first = yield* start(world);

      const spawned = yield* post(world, "spawnPeon", {
        overrides: { workspace },
        peonId: "worker-a",
        template: "full",
      });

      expect(spawned.status, JSON.stringify(spawned.body)).toBe(200);
      expect(spawned.body).toMatchObject({ state: "idle" });

      yield* post(world, "promptPeon", {
        peonId: "worker-a",
        requestId: "turn-eviction",
        text: "hold-until-eviction",
      }).pipe(Effect.option, Effect.forkScoped);
      yield* readCalls(world).pipe(
        Effect.filterOrFail(
          (calls) => calls.some(({ path }) => path.endsWith("/prompt")),
          () => "box has not stored its result"
        ),
        Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 })
      );

      const running = yield* report(world);
      expect(running.state).toBe("running");
      expect(running.pending).toMatchObject({
        kind: "prompt",
        requestId: "turn-eviction",
      });

      const runningList = yield* post(world, "listPeons", { state: "running" });
      expect(runningList.body).toMatchObject({
        peons: [{ peonId: "worker-a", state: "running" }],
      });

      const concurrentClone = yield* post(world, "clonePeon", {
        newPeonId: "must-not-exist",
        peonId: "worker-a",
      });

      expect(concurrentClone.status).toBe(422);

      yield* kill(first);
      yield* start(world);
      const recovered = yield* untilReport(world, "idle");

      expect(recovered.usage.total).toBe(39);
      expect(recovered.lastTurn?.output).toContain("remember");

      const replay = yield* post(world, "promptPeon", {
        peonId: "worker-a",
        requestId: "turn-eviction",
        text: "hold-until-eviction",
      });

      expect(replay.body).toMatchObject({ usage: { total: 39 } });

      const calls = yield* readCalls(world);

      const promptIds = calls
        .filter(({ path }) => path.endsWith("/prompt"))
        .map(({ requestId }) => requestId);

      expect(promptIds).toHaveLength(2);
      expect(new Set(promptIds).size).toBe(1);
      expect(promptIds[0]).toMatch(/^[a-f0-9]{64}$/u);
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000
);

it.live(
  "authenticated peons clone, sleep, page their index, preserve template versions and leave registry tombstones",
  () =>
    Effect.gen(function* lifecycle() {
      const other = yield* freshCaller("other");
      const world = yield* prepare(200, [other], undefined, { peons: true });
      yield* start(world);

      const ungranted = yield* post(world, "listPeonTemplates", {}, other);
      expect(ungranted.status).toBe(403);

      const refused = yield* post(world, "spawnPeon", {
        overrides: { workspace },
        peonId: "readonly",
        template: { name: "read-only" },
      });

      expect(JSON.stringify(refused.body)).toContain("workspace think");

      const saved = yield* post(world, "savePeonTemplate", {
        extends: "full",
        name: "warm-worker",
        overrides: {
          limits: { cpus: 4 },
          warm: { contract: "Remember the task" },
          workspace,
        },
      });

      expect(saved.body).toMatchObject({
        template: { limits: { cpus: 4, memory: "4g", pids: 512, tmp: "1g" } },
        version: 1,
      });

      const spawned = yield* post(world, "spawnPeon", {
        peonId: "worker-a",
        template: { name: "warm-worker", version: 1 },
      });

      expect(spawned.status, JSON.stringify(spawned.body)).toBe(200);

      const cloned = yield* post(world, "clonePeon", {
        newPeonId: "worker-b",
        peonId: "worker-a",
        requestId: "clone-1",
      });

      expect(cloned.body).toMatchObject({
        peonId: "worker-b",
        resolvedTemplate: { warm: { contract: "Remember the task" } },
        state: "suspended",
      });

      const awakePage = yield* post(world, "listPeons", { limit: 1 });
      expect(awakePage.body).toMatchObject({
        cursor: null,
        peons: [{ peonId: "worker-a" }],
      });

      const collision = yield* post(world, "clonePeon", {
        newPeonId: "worker-b",
        peonId: "worker-a",
        requestId: "clone-collision",
      });

      expect(collision.status).toBe(422);
      expect((yield* report(world)).state).toBe("idle");

      yield* post(world, "suspendPeon", { peonId: "worker-a" });
      yield* post(world, "suspendPeon", { peonId: "worker-a" });

      const suspendedClone = yield* post(world, "clonePeon", {
        newPeonId: "worker-c",
        peonId: "worker-a",
      });

      expect(suspendedClone.body).toMatchObject({
        peonId: "worker-c",
        state: "suspended",
      });
      const awake = yield* post(world, "listPeons", {});
      expect(awake.body).toMatchObject({ peons: [] });

      const sleeping = yield* post(world, "listPeons", {
        limit: 1,
        state: ["suspended", "hibernated"],
      });

      expect(sleeping.body).toMatchObject({
        cursor: "worker-a",
        peons: [{ peonId: "worker-a" }],
      });

      yield* post(world, "hibernatePeon", {
        peonId: "worker-a",
        requestId: "hibernate-1",
      });

      const hibernatedClone = yield* post(world, "clonePeon", {
        newPeonId: "worker-d",
        peonId: "worker-a",
      });

      expect(hibernatedClone.body).toMatchObject({
        peonId: "worker-d",
        state: "suspended",
      });

      yield* post(world, "resumePeon", {
        peonId: "worker-a",
        requestId: "resume-1",
      });
      expect((yield* report(world)).state).toBe("idle");

      yield* post(world, "destroyPeon", {
        peonId: "worker-a",
        requestId: "destroy-1",
      });

      const tombstone = yield* post(world, "inspectPeon", {
        peonId: "worker-a",
      });

      expect(
        Option.isSome(Schema.decodeUnknownOption(PeonTombstone)(tombstone.body))
      ).toBe(true);
      expect(JSON.stringify(tombstone.body)).not.toContain("Remember the task");

      const listed = yield* post(world, "listPeons", { state: "all" });
      expect(listed.body).toMatchObject({
        peons: [
          { peonId: "worker-a", state: "destroyed" },
          { peonId: "worker-b", state: "suspended" },
          { peonId: "worker-c", state: "suspended" },
          { peonId: "worker-d", state: "suspended" },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000
);
