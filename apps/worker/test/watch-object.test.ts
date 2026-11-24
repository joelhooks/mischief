// @effect-diagnostics asyncFunction:off -- esbuild's fixture compilation uses a Promise API.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The loopback fixture generates ephemeral P-256 keys and exports Node KeyObjects.
import { generateKeyPairSync } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture needs to hold the raw response socket open until workerd dies.
import { createServer } from "node:http";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { armWatchContract, WatchInspection } from "@mischief/core";
import {
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import type { Json } from "effect/Schema";
import { build } from "esbuild";

import { didFor } from "../src/fleet-names.js";
import {
  bearer,
  freshCaller,
  getJson,
  kill,
  post,
  postAs,
  prepare,
  start,
} from "./workerd.js";
import type { Workerd } from "./workerd.js";

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

const refsOf = (value: Json): readonly string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(refsOf);
  }

  const node = Schema.decodeUnknownOption(Schema.JsonObject)(value);

  return Option.match(node, {
    onNone: () => [],
    onSome: (record) =>
      Object.entries(record).flatMap(([key, child]) =>
        key === "$ref" && Predicate.isString(child) ? [child] : refsOf(child)
      ),
  });
};

const verifyWatchOpenApi = (world: Workerd) =>
  Effect.gen(function* verifySpec() {
    const authorization = yield* bearer(world.driver, "openApi");
    const response = yield* getJson(world, "/openapi.json", authorization);
    expect(response.status).toBe(200);

    const spec = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        paths: Schema.Record(Schema.String, Schema.JsonObject),
        components: Schema.Struct({ schemas: Schema.JsonObject }),
      })
    )(response.body);

    for (const name of [
      "armWatch",
      "listWatches",
      "inspectWatch",
      "cancelWatch",
      "completeWatch",
    ]) {
      const operation = spec.paths[`/${name}`]?.post;
      expect(operation).toBeDefined();
      const refs = refsOf(operation ?? null);
      expect(refs.length).toBeGreaterThan(0);

      for (const ref of [...refs, ...refsOf(spec.components.schemas)]) {
        expect(ref.startsWith("#/components/schemas/")).toBe(true);
        expect(
          Object.hasOwn(
            spec.components.schemas,
            ref.slice("#/components/schemas/".length)
          )
        ).toBe(true);
      }
    }
  });

const definition = {
  condition: {
    expect: { status: 200 },
    type: "http",
    url: "https://checks.example.invalid/ready",
  },
  intervalSeconds: 60,
  kind: "once",
  label: "Restarted watch",
  message: { body: "Ready", summary: "Ready" },
  notify: { cc: [], to: ["example/desk"] },
  requestId: "watch-test-request",
  timeoutSeconds: 2,
} satisfies typeof armWatchContract.input.Type;

it.live(
  "signed watch routes enforce grants and ownership and the stored alarm wakes a fresh workerd",
  () =>
    Effect.gen(function* watchSurvivesRestart() {
      const peer = yield* freshCaller("watch-peer");
      const ungranted = yield* freshCaller("watch-ungranted");

      const world = yield* prepare(500, [peer, ungranted], undefined, {
        watchOwners: [peer.did],
      });

      const first = yield* start(world);
      yield* verifyWatchOpenApi(world);
      const denied = yield* post(world, "armWatch", definition, ungranted);
      expect(denied.body).toMatchObject({ code: "NotGranted" });

      const offHost = yield* post(world, "armWatch", {
        ...definition,
        condition: {
          ...definition.condition,
          url: "https://foreign.example.invalid/",
        },
      });

      expect(offHost.body).toMatchObject({ code: "HostNotAllowed" });
      const armed = yield* post(world, "armWatch", definition);
      expect(armed.status).toBe(200);

      const { watchId } = yield* Schema.decodeUnknownEffect(
        armWatchContract.output
      )(armed.body);

      expect((yield* post(world, "armWatch", definition)).body).toEqual(
        armed.body
      );

      const listing = yield* post(world, "listWatches", {
        owner: world.driver.did,
        target: "example/desk",
      });

      expect(listing.body).toMatchObject({ watches: [{ watchId }] });

      const mismatched = yield* post(world, "listWatches", {
        target: "different/desk",
      });

      expect(mismatched.body).toEqual({ watches: [] });

      for (const name of ["cancelWatch", "completeWatch"]) {
        const deniedStop = yield* post(
          world,
          name,
          { requestId: name, watchId },
          peer
        );

        expect(deniedStop.body).toMatchObject({ code: "NotOwner" });
      }

      const inspect = post(world, "inspectWatch", { watchId }).pipe(
        Effect.flatMap(({ body }) =>
          Schema.decodeUnknownEffect(WatchInspection)(body)
        )
      );

      expect((yield* inspect).watch.state).toBe("armed");
      yield* kill(first);
      yield* start(world);

      const expired = yield* inspect.pipe(
        Effect.filterOrFail(
          ({ watch }) => watch.state === "expired",
          () => "Watch alarm has not expired yet"
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 80 })
      );

      expect(expired.lastCheck).toBeNull();
      expect(expired.firings).toEqual([]);
    }).pipe(Effect.provide(services)),
  15_000
);

const watchBundle = Effect.gen(function* buildWatchFixture() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const outfile = path.join(dir, "watch-worker.js");
  yield* Effect.promise(
    async () =>
      await build({
        bundle: true,
        conditions: ["workerd", "worker", "browser", "import"],
        define: { __BUNDLE_COMMIT__: '"test"', __BUNDLE_VERSION__: '"test"' },
        entryPoints: [
          path.resolve(import.meta.dirname, "fixtures/watch-worker.ts"),
        ],
        external: ["cloudflare:*", "node:*"],
        format: "esm",
        logLevel: "warning",
        mainFields: ["module", "main"],
        outfile,
        platform: "neutral",
      })
  );

  return outfile;
});

const testKey = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const mailboxFixture = (holdFirst: boolean) => {
  const did = Option.getOrThrow(didFor("mischief/worker"));
  const recipient = Option.getOrThrow(didFor("example/desk"));
  const signing = testKey();
  const agreement = testKey();
  const recipientSigning = testKey();
  const recipientAgreement = testKey();

  const peerDocument = (peer: string) => ({
    id: peer,
    verificationMethod: [
      {
        id: `${peer}#signing`,
        type: "JsonWebKey2020",
        controller: peer,
        publicKeyJwk: recipientSigning.publicKey.export({ format: "jwk" }),
      },
      {
        id: `${peer}#encryption`,
        type: "JsonWebKey2020",
        controller: peer,
        publicKeyJwk: recipientAgreement.publicKey.export({ format: "jwk" }),
      },
    ],
    authentication: [`${peer}#signing`],
    keyAgreement: [`${peer}#encryption`],
  });

  const identity = JSON.stringify({
    did,
    signing: signing.privateKey.export({ format: "jwk" }),
    agreement: agreement.privateKey.export({ format: "jwk" }),
  });

  const attempts: string[] = [];

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");

    if (url.pathname === "/ready") {
      response.end(
        JSON.stringify({
          check_runs: [
            {
              id: 501,
              name: "ci",
              status: "completed",
              head_sha: "a".repeat(40),
              conclusion: "success",
              completed_at: null,
            },
          ],
        })
      );

      return;
    }

    const peer = url.searchParams.get("did");

    if (
      url.pathname.endsWith(".getPeerDocument") &&
      (peer === recipient ||
        peer === "did:web:watch-budget.pi.ratking-fleet.invalid")
    ) {
      response.end(JSON.stringify({ document: peerDocument(peer) }));

      return;
    }

    if (url.pathname.endsWith(".send")) {
      request.setEncoding("utf-8");
      let body = "";
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        attempts.push(body);

        if (!holdFirst || attempts.length > 1) {
          response
            .writeHead(409)
            .end(
              JSON.stringify({ error: "Conflict", message: "Already admitted" })
            );
        }
      });

      return;
    }

    response
      .writeHead(404)
      .end(
        JSON.stringify({ error: "NotFound", message: "Not a fixture route" })
      );
  });

  return Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = Schema.decodeUnknownSync(
          Schema.Struct({ port: Schema.Int })
        )(server.address());

        resume(Effect.succeed(port));
      });
    }),
    () =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      })
  ).pipe(Effect.map((port) => ({ port, identity, attempts })));
};

const readAttempt = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      woke: Schema.Boolean,
      envelope: Schema.Struct({
        aad: Schema.Struct({ recipientDid: Schema.String }),
      }),
    })
  )
);

const fixtureDefinition = {
  ...definition,
  condition: {
    ...definition.condition,
    expect: {
      jsonPath: '$.check_runs[?(@.name=="ci")].status',
      equals: "completed",
    },
  },
  timeoutSeconds: 120,
} satisfies typeof armWatchContract.input.Type;

const armFixture = (
  world: Workerd,
  input: typeof armWatchContract.input.Type,
  caller = world.driver
) =>
  post(world, "armWatch", input, caller).pipe(
    Effect.flatMap(({ body }) =>
      Schema.decodeUnknownEffect(armWatchContract.output)(body)
    )
  );

const fireSoon = (world: Workerd, watchId: string) =>
  postAs(
    world,
    `test/watch-fire?watchId=${encodeURIComponent(watchId)}`,
    null,
    ""
  ).pipe(
    Effect.tap(({ status }) =>
      Effect.sync(() => {
        expect(status).toBe(200);
      })
    )
  );

const inspected = (world: Workerd, watchId: string, caller = world.driver) =>
  post(world, "inspectWatch", { watchId }, caller).pipe(
    Effect.flatMap(({ body }) =>
      Schema.decodeUnknownEffect(WatchInspection)(body)
    )
  );

const retryLocal = { schedule: Schedule.spaced("50 millis"), times: 200 };

const settled = (world: Workerd, watchId: string, caller = world.driver) =>
  inspected(world, watchId, caller).pipe(
    Effect.filterOrFail(
      ({ firings, watch }) => firings.length === 1 && watch.state === "done",
      () => "The fixture firing has not settled"
    ),
    Effect.retry(retryLocal)
  );

it.live(
  "workerd resumes a persisted HTTP firing after SIGKILL with identical signed bytes",
  () =>
    Effect.gen(function* replayHttpFiring() {
      const bundle = yield* watchBundle;
      const mail = yield* mailboxFixture(true);

      const world = yield* prepare(500, [], undefined, {
        bundle,
        watchOwners: [],
        watchMail: mail,
      });

      const first = yield* start(world);
      const { watchId } = yield* armFixture(world, fixtureDefinition);
      yield* fireSoon(world, watchId);
      yield* Effect.sync(() => mail.attempts.length).pipe(
        Effect.filterOrFail(
          (count) => count === 1,
          () => "No signed send arrived"
        ),
        Effect.retry(retryLocal)
      );
      expect((yield* inspected(world, watchId)).watch.state).toBe("fired");
      yield* kill(first);
      yield* start(world);
      const receipt = yield* settled(world, watchId);
      expect(receipt.watch.state).toBe("done");
      expect(mail.attempts).toHaveLength(2);
      expect(mail.attempts[0]).toBe(mail.attempts[1]);
      expect(receipt.lastCheck?.outcome).toBe("true");
    }).pipe(Effect.provide(services)),
  20_000
);

it.live(
  "concurrent WatchObjects share the twentieth wake and record the quiet downgrade",
  () =>
    Effect.gen(function* shareBudget() {
      const bundle = yield* watchBundle;
      const mail = yield* mailboxFixture(false);
      const caller = yield* freshCaller("watch-budget.pi");

      const world = yield* prepare(500, [caller], undefined, {
        bundle,
        watchOwners: [caller.did],
        watchMail: mail,
      });

      yield* start(world);
      expect((yield* postAs(world, "test/watch-budget", null, "")).status).toBe(
        200
      );

      const watches = yield* Effect.forEach(
        ["first", "second"],
        (requestId) =>
          armFixture(world, { ...fixtureDefinition, requestId }, caller),
        { concurrency: "unbounded" }
      );

      yield* Effect.forEach(
        watches,
        ({ watchId }) => fireSoon(world, watchId),
        { concurrency: "unbounded" }
      );

      const receipts = yield* Effect.forEach(
        watches,
        ({ watchId }) => settled(world, watchId, caller),
        { concurrency: "unbounded" }
      );

      expect(
        receipts.flatMap(({ firings }) =>
          firings.flatMap(({ downgraded }) => downgraded)
        )
      ).toEqual(["example/desk"]);
      const deliveries = mail.attempts.map((attempt) => readAttempt(attempt));
      const target = Option.getOrThrow(didFor("example/desk"));
      expect(
        deliveries
          .flatMap(({ envelope, woke }) =>
            envelope.aad.recipientDid === target ? [woke] : []
          )
          .toSorted((left, right) => Number(left) - Number(right))
      ).toEqual([false, true]);
      expect(deliveries).toHaveLength(3);
    }).pipe(Effect.provide(services)),
  20_000
);

it.live(
  "the WatchObject observes an owned peon through the registry and refuses a foreign peon",
  () =>
    Effect.gen(function* ownedPeonWatch() {
      const bundle = yield* watchBundle;
      const other = yield* freshCaller("other-peon-watch");

      const world = yield* prepare(500, [other], undefined, {
        bundle,
        peons: true,
        watchOwners: [other.did],
      });

      yield* start(world);
      const peonId = "owned-watch-peon";
      expect(
        (yield* post(world, "spawnPeon", {
          peonId,
          template: "full",
          overrides: {
            workspace: { repo: "example/project", sha: "a".repeat(40) },
          },
        })).status
      ).toBe(200);

      const input = {
        ...fixtureDefinition,
        condition: {
          type: "peon",
          peonId,
          expect: { state: "idle", pendingClear: true },
        },
      } as const;

      const { watchId } = yield* armFixture(world, input);
      const foreign = yield* post(world, "armWatch", input, other);

      const { watchId: foreignId } = yield* Schema.decodeUnknownEffect(
        armWatchContract.output
      )(foreign.body);

      yield* fireSoon(world, watchId);
      yield* fireSoon(world, foreignId);

      const observation = (id: string, caller = world.driver) =>
        inspected(world, id, caller).pipe(
          Effect.filterOrFail(
            ({ lastCheck }) => lastCheck !== null,
            () => "No peon observation yet"
          ),
          Effect.retry(retryLocal)
        );

      expect((yield* observation(watchId)).lastCheck).toMatchObject({
        outcome: "true",
      });
      const rejected = yield* observation(foreignId, other);
      expect(rejected.lastCheck).toMatchObject({ outcome: "checkError" });
      expect(rejected.firings).toEqual([]);
    }).pipe(Effect.provide(services)),
  20_000
);
