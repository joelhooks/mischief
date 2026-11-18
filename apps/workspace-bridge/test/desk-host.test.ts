import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted, Tracer } from "effect";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import { deskHostRoutes } from "../src/desk-host-http.js";
import { DeskHost } from "../src/desk-host.js";
import { Restore, restoreCommand } from "../src/desk-restore.js";
import type { RestoreReceipt } from "../src/desk-restore.js";

const desk = "sample/desk";

const base = `/v1/desks/${encodeURIComponent(desk)}`;

it.effect(
  "desk host authenticates both routes before probing or restoring and validates SSH argv inputs",
  () =>
    Effect.gen(function* authBoundary() {
      const calls: string[] = [];

      const dir = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped()
      );

      const restore = Layer.succeed(
        Restore,
        Restore.of({
          run: (name, messageId) =>
            Effect.sync(() => {
              calls.push(messageId ?? "probe");

              return { name, reason: "receipt", result: "restored" };
            }),
        })
      );

      yield* HttpRouter.serve(deskHostRoutes(Redacted.make("desk-secret")), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(DeskHost.layer(dir).pipe(Layer.provide(restore))),
        Layer.build
      );

      const post = (messageId: string, auth: string, url = `${base}/wake`) =>
        HttpClient.post(url, {
          body: HttpBody.jsonUnsafe({ messageId }),
          headers: { authorization: auth },
        });

      const auth = "Bearer desk-secret";
      expect((yield* post("id", "Bearer wrong")).status).toBe(401);
      expect((yield* HttpClient.get(`${base}/lease`)).status).toBe(401);
      expect((yield* post("id;id", auth)).status).toBe(400);
      expect(
        (yield* post("id", auth, "/v1/desks/sample%2Fdesk%3Bid/wake")).status
      ).toBe(400);
      expect(calls).toEqual([]);

      const wake = yield* post("id", auth);
      expect(wake.status).toBe(200);
      expect(yield* wake.json).toEqual({
        reason: "receipt",
        result: "restored",
      });

      const lease = yield* HttpClient.get(`${base}/lease`, {
        headers: { authorization: auth },
      });

      expect(yield* lease.json).toEqual({ live: false });
      expect(calls).toEqual(["probe", "id", "probe"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer)),
      Effect.provideService(Tracer.DisablePropagation, true)
    )
);

it.effect(
  "successful and lost wakes replay their local receipts across host restart; failed ids remain retryable",
  () =>
    Effect.gen(function* restartHost() {
      const dir = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped()
      );

      const calls: (string | undefined)[] = [];
      let live = false;
      let fails = true;

      const restore = Layer.succeed(
        Restore,
        Restore.of({
          run: (name, messageId) =>
            Effect.sync((): RestoreReceipt => {
              calls.push(messageId);

              if (messageId === undefined) {
                return {
                  name,
                  reason: "probe",
                  result: live ? "alreadyLive" : "restored",
                };
              }

              return {
                name,
                reason: "restore receipt",
                result: fails ? "failed" : "restored",
              };
            }),
        })
      );

      const request = (id: string) =>
        DeskHost.use(({ wake }) => wake(desk, id)).pipe(
          Effect.provide(DeskHost.layer(dir).pipe(Layer.provide(restore)))
        );

      expect((yield* request("trigger")).result).toBe("failed");
      fails = false;
      const restored = yield* request("trigger");
      expect(restored.result).toBe("restored");
      live = true;
      expect(yield* request("trigger")).toEqual(restored);
      const lost = yield* request("lost-id");
      expect(lost.result).toBe("lost");
      live = false;
      expect(yield* request("lost-id")).toEqual(lost);
      expect(calls).toEqual([undefined, "trigger", "trigger", undefined]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "does not cache refused or in-flight restore outcomes and retries the original Muster id",
  () =>
    Effect.gen(function* musterVerdicts() {
      const dir = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped()
      );

      const calls: (string | undefined)[] = [];
      let probeRefused = true;
      let concurrentReady = false;

      const restore = Layer.succeed(
        Restore,
        Restore.of({
          run: (name, messageId) =>
            Effect.sync((): RestoreReceipt => {
              calls.push(messageId);

              if (messageId === undefined) {
                if (probeRefused) {
                  return {
                    name,
                    permanent: false,
                    ready: false,
                    reason: "Machine not opted in",
                    result: "refused",
                  };
                }

                return {
                  name,
                  ready: concurrentReady,
                  reason: null,
                  result: concurrentReady ? "alreadyLive" : "restored",
                };
              }

              if (messageId === "launch-refused") {
                return {
                  name,
                  messageId,
                  permanent: true,
                  ready: false,
                  reason: "Row is pinned",
                  result: "refused",
                };
              }

              if (messageId === "concurrent") {
                return concurrentReady
                  ? {
                      name,
                      messageId,
                      ready: true,
                      reason: null,
                      result: "alreadyLive",
                    }
                  : {
                      name,
                      messageId,
                      ready: false,
                      reason: "wake in progress",
                      result: "failed",
                    };
              }

              return {
                name,
                messageId,
                ready: true,
                reason: null,
                result: "restored",
              };
            }),
        })
      );

      const request = (id: string) =>
        DeskHost.use(({ wake }) => wake(desk, id)).pipe(
          Effect.provide(DeskHost.layer(dir).pipe(Layer.provide(restore)))
        );

      const refusedLease = yield* DeskHost.use(({ lease }) => lease(desk)).pipe(
        Effect.provide(DeskHost.layer(dir).pipe(Layer.provide(restore)))
      );

      expect(refusedLease).toEqual({
        permanent: true,
        reason: "Machine not opted in (Muster permanent=false)",
      });
      const refused = yield* request("probe-refused");
      expect(refused).toEqual({
        permanent: true,
        ready: false,
        reason: "Machine not opted in (Muster permanent=false)",
        result: "failed",
      });
      probeRefused = false;
      expect(yield* request("probe-refused")).toMatchObject({
        ready: true,
        result: "restored",
      });
      expect(yield* request("launch-refused")).toMatchObject({
        permanent: true,
        reason: "Row is pinned (Muster permanent=true)",
        result: "failed",
      });
      expect(yield* request("concurrent")).toEqual({
        inProgress: true,
        ready: false,
        reason: "wake in progress",
        result: "failed",
      });
      concurrentReady = true;
      expect(yield* request("concurrent")).toMatchObject({
        ready: true,
        result: "restored",
      });
      expect(calls).toEqual([
        undefined,
        undefined,
        undefined,
        "probe-refused",
        undefined,
        "launch-refused",
        undefined,
        "concurrent",
        "concurrent",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const command = `
const args = process.argv.slice(1);
const name = args[args.indexOf('--name') + 1];
const messageId = args[args.indexOf('--message-id') + 1];
if (process.env.RATKING_EXIT_WHEN_DRAINED !== '12') process.exit(77);
if (args[0] === '--dry-run') {
  if (args.length !== 3) process.exit(77);
  console.log(JSON.stringify({ name, messageId: null, result: 'alreadyLive', reason: 'held' }));
} else if (messageId === 'transport') {
  process.stderr.write('private material ' + 'x'.repeat(1200) + ' Permission denied (publickey) more private material');
  process.exitCode = 255;
} else {
  if (args[args.indexOf('--exit-when-drained') + 1] !== '12') process.exit(77);
  const result = messageId === 'refusal' ? 'refused' : messageId === 'failure' ? 'failed' : 'restored';
  console.log(JSON.stringify({ name, messageId, result, ready: result === 'restored', permanent: result === 'refused' ? false : null, reason: null, extra: 'accepted' }));
  process.exitCode = result === 'restored' ? 0 : result === 'refused' ? 2 : 1;
}`;

it.live(
  "command adapter passes the dry-run and drain argv, checks exit receipts, and redacts a transport failure",
  () =>
    Effect.gen(function* adapter() {
      const restore = yield* Restore;
      expect((yield* restore.run(desk)).result).toBe("alreadyLive");

      for (const [id, result] of [
        ["success", "restored"],
        ["refusal", "refused"],
        ["failure", "failed"],
      ] as const) {
        expect(yield* restore.run(desk, id)).toMatchObject({
          ready: result === "restored",
          reason: null,
          result,
        });
      }

      const transport = yield* restore.run(desk, "transport").pipe(Effect.flip);
      expect(transport.message).toContain("255: Permission denied (publickey)");
      expect(transport.message).not.toContain("private material");
    }).pipe(
      Effect.provide(
        restoreCommand([process.execPath, "-e", command, "--"], 12).pipe(
          Layer.provide(NodeServices.layer)
        )
      )
    )
);
