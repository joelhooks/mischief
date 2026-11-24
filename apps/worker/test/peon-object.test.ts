import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  PeonRefused,
  PeonReport,
  PeonTailForbidden,
  PeonTailNotFound,
  PeonTombstone,
  tailPeonContract,
} from "@mischief/core";
import { Effect, Fiber, Layer, Option, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { freshCaller, kill, post, prepare, start } from "./workerd.js";
import type { Workerd } from "./workerd.js";

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

const workspace = { repo: "example/project", sha: "a".repeat(40) };

const Calls = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    requestId: Schema.String,
    discardWorkspace: Schema.optionalKey(Schema.Literal(true)),
    landedHead: Schema.optionalKey(Schema.String),
  })
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

it.live(
  "tailPeon accepts an existing inspect grant but never reads a foreign or missing peon",
  () =>
    Effect.gen(function* tailAccess() {
      const other = yield* freshCaller("other-tail-reader");

      const world = yield* prepare(200, [other], undefined, {
        peons: true,
        peonReaders: [other.did],
      });

      yield* start(world);
      const peonId = "tail-owner";

      const spawn = yield* post(world, "spawnPeon", {
        peonId,
        template: "full",
        overrides: { workspace },
      });

      expect(spawn.status).toBe(200);

      const turn = yield* post(world, "promptPeon", {
        peonId,
        text: "test turn",
        requestId: "first-turn",
      });

      const turnReport = yield* Schema.decodeUnknownEffect(PeonReport)(
        turn.body
      );

      expect(turnReport.lastTurn?.output).toContain("fake-last-turn-key");

      const before = yield* readCalls(world);
      const foreign = yield* post(world, "tailPeon", { peonId }, other);

      const missing = yield* post(world, "tailPeon", {
        peonId: "missing-tail",
      });

      expect(foreign.status).toBe(403);
      expect(missing.status).toBe(404);

      const forbidden = yield* Schema.decodeUnknownEffect(PeonTailForbidden)(
        foreign.body
      );

      const notFound = yield* Schema.decodeUnknownEffect(PeonTailNotFound)(
        missing.body
      );

      expect(forbidden.reason).toContain("Only the owner");
      expect(notFound.reason).toContain("No peon record");
      expect(yield* readCalls(world)).toEqual(before);

      const owner = yield* post(world, "tailPeon", { peonId, entries: 1 });
      expect(owner.status, JSON.stringify(owner.body)).toBe(200);

      const page = yield* Schema.decodeUnknownEffect(tailPeonContract.output)(
        owner.body
      );

      expect(page).toMatchObject({
        entries: [{ bytes: 50, type: "assistant" }],
        lastTurn: {
          exit: 0,
          toolCallCount: 2,
          toolCalls: ["edit", "bash"],
          output: "I remember the file we wrote. [redacted]",
        },
        peonId,
        state: "idle",
        status: "tail",
      });
      expect(JSON.stringify(owner.body)).not.toContain("fake-last-turn-key");
      expect(JSON.stringify(owner.body)).not.toContain("private-clipboard");
      expect((yield* readCalls(world)).slice(before.length)).toEqual([
        { path: `/v1/boxes/${peonId}/tail`, requestId: "tail-read" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000
);

it.live(
  "a committed prompt failure and its replay do not block a new turn",
  () =>
    Effect.gen(function* failedTurn() {
      const world = yield* prepare(200, [], undefined, { peons: true });
      yield* start(world);

      const peonId = "worker-a";

      const spawned = yield* post(world, "spawnPeon", {
        peonId,
        template: "full",
        overrides: { workspace },
      });

      expect(spawned.status).toBe(200);

      for (const attempt of ["fresh", "replay"]) {
        const failure = yield* post(world, "promptPeon", {
          peonId,
          requestId: "failed-turn",
          text: "fail-this-turn",
        });

        expect(failure.status, attempt).toBe(422);
        expect(failure.body, attempt).toMatchObject({ code: "PromptFailed" });
        const stored = yield* report(world);

        const box = yield* HttpClient.get(
          `http://127.0.0.1:${world.boxPort}/v1/boxes/${peonId}`,
          { headers: { authorization: "Bearer fake-box-key" } }
        ).pipe(Effect.flatMap((response) => response.json));

        expect(box).toMatchObject({ state: "suspended" });
        expect(stored.fault).toContain("The provider is unavailable.");
        expect(stored).toMatchObject({
          lastTurn: null,
          pending: null,
          state: "suspended",
        });
      }

      const next = yield* post(world, "promptPeon", {
        peonId,
        requestId: "next-turn",
        text: "continue",
      });

      expect(next.status).toBe(200);
      expect(yield* report(world)).toMatchObject({
        fault: null,
        pending: null,
        state: "idle",
      });

      const prompts = (yield* readCalls(world)).filter(({ path }) =>
        path.endsWith("/prompt")
      );

      expect(prompts).toHaveLength(3);
      expect(prompts[0]?.requestId).toBe(prompts[1]?.requestId);
      expect(prompts[2]?.requestId).not.toBe(prompts[1]?.requestId);
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000
);

it.live(
  "a stale browser resume returns a coded conflict and leaves the peon suspended",
  () =>
    Effect.gen(function* staleResume() {
      const world = yield* prepare(200, [], undefined, { peons: true });
      yield* start(world);
      const peonId = "stale-browser";

      const spawned = yield* post(world, "spawnPeon", {
        peonId,
        template: "browser",
        overrides: {
          browser: { hosts: ["browser.example.invalid"] },
          workspace,
        },
      });

      expect(spawned.status).toBe(200);
      expect((yield* post(world, "suspendPeon", { peonId })).status).toBe(200);

      const refusal = yield* post(world, "resumePeon", {
        peonId,
        requestId: "stale-resume",
      });

      expect(refusal.status, JSON.stringify(refusal.body)).toBe(409);

      const decoded = yield* Schema.decodeUnknownEffect(PeonRefused)(
        refusal.body
      );

      expect(decoded._tag).toBe("PeonRefused");
      expect(decoded.code).toBe("BoxNetworkStale");
      expect(decoded.reason).toContain(
        "Recreate or destroy this browser box before retrying."
      );

      const inspection = yield* post(world, "inspectPeon", { peonId });
      expect(inspection.status).toBe(200);
      expect(inspection.body).toMatchObject({
        fault: null,
        pending: null,
        state: "suspended",
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000
);

it.live(
  "a 503 on resume keeps the pending intent and retries the same box request",
  () =>
    Effect.gen(function* unavailableResume() {
      const world = yield* prepare(200, [], undefined, { peons: true });
      yield* start(world);
      const peonId = "unavailable-resume";
      const requestId = "transient-resume";

      const spawned = yield* post(world, "spawnPeon", {
        peonId,
        template: "full",
        overrides: { workspace },
      });

      expect(spawned.status).toBe(200);
      expect((yield* post(world, "suspendPeon", { peonId })).status).toBe(200);

      const refusal = yield* post(world, "resumePeon", { peonId, requestId });
      expect(refusal.status).toBe(422);

      const inspection = yield* post(world, "inspectPeon", { peonId });
      expect(inspection.body).toMatchObject({
        pending: { kind: "resume", requestId },
        state: "suspended",
      });

      const calls = yield* readCalls(world).pipe(
        Effect.map((rows) =>
          rows.filter(({ path }) => path === `/v1/boxes/${peonId}/resume`)
        ),
        Effect.filterOrFail(
          (rows) => rows.length >= 2,
          () => "The resume alarm has not retried"
        ),
        Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 200 })
      );

      expect(new Set(calls.map((call) => call.requestId)).size).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000
);

const custodyCases = [
  [
    "custody-incomplete",
    "CustodyIncomplete",
    "Session files were skipped.",
    "Recover the skipped session files, then retry destroyPeon.",
  ],
  [
    "replica-pending",
    "ReplicaPending",
    "The archive replica is still copying.",
    "The replica copy hasn't verified yet; retry destroyPeon after it has.",
  ],
  [
    "replica-mismatch",
    "ReplicaMismatch",
    "The replica checksum differs from the primary.",
    "Ask the Mischief operator to repair and verify the replica before retrying destroyPeon.",
  ],
  [
    "workspace-unlanded",
    "WorkspaceUnlanded",
    "The workspace has unlanded changes.",
    "Retry destroyPeon with landedHead (the landed commit) or discardWorkspace: true.",
  ],
  [
    "destroy-in-progress",
    "DestroyInProgress",
    "A destroy is already recorded.",
    "Retry destroyPeon with the original workspace disposition.",
  ],
  [
    "receipt-mismatch",
    "ReceiptMismatch",
    "The primary archive receipt did not match.",
    "Ask the Mischief operator to check the protected archive before retrying destroyPeon.",
  ],
] as const;

const spawnAndDestroy = Effect.fn("test.spawnAndDestroy")(
  function* spawnAndDestroy(world: Workerd, peonId: string) {
    const spawned = yield* post(world, "spawnPeon", {
      overrides: { workspace },
      peonId,
      template: "full",
    });

    expect(spawned.status, JSON.stringify(spawned.body)).toBe(200);

    const refused = yield* post(world, "destroyPeon", {
      discardWorkspace: true,
      peonId,
      requestId: `destroy-${peonId}`,
    });

    expect(refused.status).toBe(422);

    return refused.body;
  }
);

it.live(
  "destroyPeon preserves bridge refusals from destroy and export",
  () =>
    Effect.gen(function* custodyRefusals() {
      const world = yield* prepare(200, [], undefined, { peons: true });
      yield* start(world);

      for (const [peonId, code, message, nextStep] of custodyCases) {
        const body = yield* spawnAndDestroy(world, peonId);
        const failure = yield* Schema.decodeUnknownEffect(PeonRefused)(body);

        expect(failure.code).toBe(code);
        expect(failure.reason).toContain(message);
        expect(failure.reason.endsWith(nextStep)).toBe(true);

        if (code === "WorkspaceUnlanded") {
          expect(failure.reason).toContain("src/draft.ts");
          expect(failure.reason).toContain("refs/heads/draft");
          expect(failure.reason).toContain("…and 980 more");
          expect(failure.reason).toContain("…and 1 more");
          expect(failure.reason).not.toContain("message-tail");
          expect(failure.reason.length).toBeLessThan(1024);
        }

        const inspected = yield* post(world, "inspectPeon", { peonId });

        expect(inspected.body).toMatchObject({ pending: null });
      }

      const peonId = "generic-failure";
      const body = yield* spawnAndDestroy(world, peonId);
      const failure = yield* Schema.decodeUnknownEffect(PeonRefused)(body);

      expect(body).not.toHaveProperty("code");
      expect(failure.reason).toMatch(/^Peon object call failed:/u);

      const inspected = yield* post(world, "inspectPeon", { peonId });

      expect(inspected.body).toMatchObject({
        pending: { kind: "destroy", requestId: `destroy-${peonId}` },
        state: "suspended",
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000
);

it.live(
  "a refused destroy leaves a hibernated peon hibernated in inspect and list",
  () =>
    Effect.gen(function* refuseHibernatedDestroy() {
      const world = yield* prepare(200, [], undefined, { peons: true });
      yield* start(world);
      const peonId = "worker-a";

      const spawned = yield* post(world, "spawnPeon", {
        overrides: { workspace },
        peonId,
        template: "full",
      });

      expect(spawned.status, JSON.stringify(spawned.body)).toBe(200);

      const hibernated = yield* post(world, "hibernatePeon", { peonId });

      expect(hibernated.status, JSON.stringify(hibernated.body)).toBe(200);
      expect(hibernated.body).toMatchObject({ state: "hibernated" });

      const refused = yield* post(world, "destroyPeon", {
        peonId,
        discardWorkspace: true,
        requestId: "destroy-hibernated",
      });

      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ code: "CustodyMissing" });

      const stored = yield* report(world);

      expect(stored).toMatchObject({ pending: null, state: "hibernated" });
      expect(stored.fault).toContain("CustodyMissing");

      const sleeping = yield* post(world, "listPeons", { state: "hibernated" });

      expect(sleeping.body).toMatchObject({
        peons: [{ peonId, state: "hibernated" }],
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000
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
  "a stopped box settles a pending suspend without racing a newer resume",
  () =>
    Effect.gen(function* reconcileSuspend() {
      const world = yield* prepare(60_000, [], undefined, { peons: true });
      yield* start(world);
      const peonId = "stuck-suspend";
      const suspend = { peonId, requestId: "sleep" };
      const resume = { peonId, requestId: "wake" };
      const inspect = post(world, "inspectPeon", { peonId });

      const spawned = yield* post(world, "spawnPeon", {
        overrides: { workspace },
        peonId,
        template: "full",
      });

      expect(spawned.status).toBe(200);
      expect((yield* post(world, "suspendPeon", suspend)).status).toBe(422);

      const reconciling = yield* inspect.pipe(Effect.forkScoped);
      yield* readCalls(world).pipe(
        Effect.filterOrFail(
          (calls) =>
            calls.some(({ requestId }) => requestId === "held-inspect"),
          () => "box has not observed the stopped container"
        ),
        Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 })
      );

      const busy = yield* inspect;
      expect(busy.body).toMatchObject({
        pending: { kind: "suspend", requestId: "sleep" },
      });
      const raced = yield* post(world, "resumePeon", resume);
      expect(raced.status).toBe(422);
      expect(JSON.stringify(raced.body)).toContain("concurrent turn");

      yield* HttpClient.get(
        `http://127.0.0.1:${world.boxPort}/__release-stopped-inspect`
      );
      expect((yield* Fiber.join(reconciling)).body).toMatchObject({
        bytes: null,
        pending: null,
        processes: 0,
        state: "suspended",
      });
      const resumed = yield* post(world, "resumePeon", resume);
      expect(resumed.status).toBe(200);
      expect(resumed.body).toMatchObject({ state: "idle" });
      expect((yield* post(world, "suspendPeon", suspend)).body).toMatchObject({
        state: "suspended",
      });
      expect((yield* inspect).body).toMatchObject({
        pending: null,
        state: "idle",
      });
      expect(
        (yield* readCalls(world)).filter(({ path }) =>
          path.endsWith("/suspend")
        )
      ).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(services)),
  30_000
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

      const custodyMissing = yield* post(world, "destroyPeon", {
        peonId: "worker-a",
        requestId: "destroy-1",
        discardWorkspace: true,
      });

      expect(custodyMissing.status).toBe(422);

      const refusal = yield* Schema.decodeUnknownEffect(PeonRefused)(
        custodyMissing.body
      );

      expect(refusal.code).toBe("CustodyMissing");
      expect(refusal.reason).toContain(
        "Protected archive is not configured. Configure both archive roots before exporting or destroying."
      );
      expect(
        refusal.reason.endsWith(
          "Custody is off on this host; destroy is unavailable until custody-on."
        )
      ).toBe(true);

      const legacy = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          _tag: Schema.Literal("PeonRefused"),
          reason: Schema.String,
        })
      )(custodyMissing.body);

      expect(legacy.reason).toBe(refusal.reason);

      const stored = yield* report(world);

      expect(stored).toMatchObject({ pending: null, state: "idle" });
      expect(stored.fault).toBe(refusal.reason);

      const receiptMismatch = yield* post(world, "destroyPeon", {
        peonId: "worker-a",
        requestId: "destroy-1",
        discardWorkspace: true,
      });

      expect(JSON.stringify(receiptMismatch.body)).toContain("ReceiptMismatch");
      expect((yield* report(world)).pending).toBeNull();

      const destroyed = yield* post(world, "destroyPeon", {
        peonId: "worker-a",
        requestId: "destroy-1",
        landedHead: workspace.sha,
      });

      expect(destroyed.status, JSON.stringify(destroyed.body)).toBe(200);

      const teardown = (yield* readCalls(world)).filter(
        ({ path }) =>
          path === "/v1/boxes/worker-a" || path === "/v1/boxes/worker-a/export"
      );

      expect(
        teardown.map(({ path, landedHead }) => [path, landedHead])
      ).toEqual([
        ["/v1/boxes/worker-a", undefined],
        ["/v1/boxes/worker-a", undefined],
        ["/v1/boxes/worker-a/export", undefined],
        ["/v1/boxes/worker-a", undefined],
        ["/v1/boxes/worker-a", workspace.sha],
      ]);

      const tombstone = yield* post(world, "inspectPeon", {
        peonId: "worker-a",
      });

      expect(
        Option.isSome(Schema.decodeUnknownOption(PeonTombstone)(tombstone.body))
      ).toBe(true);
      expect(tombstone.body).toMatchObject({
        exportReceipt: { id: "worker-a/archive", replicaState: "verified" },
      });
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
