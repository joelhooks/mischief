import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Redacted,
  Ref,
  Stream,
  Tracer,
} from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { RECORD_PATH } from "../src/box/spend-protocol.js";
import { FullProxy, fullProxyRoutes } from "../src/full-proxy.js";
import { modelSpend } from "../src/model-spend.js";
import { Proxy, proxyRoutes } from "../src/proxy.js";

const server = { disableListenLog: true, disableLogger: true };

const completed = (tokens: number) =>
  `data: ${JSON.stringify({ type: "response.completed", response: { usage: { total_tokens: tokens } } })}\n\n`;

const call = (client: HttpClient.HttpClient, max_output_tokens: number) =>
  client.post("/v1/responses", {
    body: HttpBody.jsonUnsafe({
      input: [],
      max_output_tokens,
      model: "gpt-6.1-sol",
      stream: true,
    }),
  });

const managerFixture = `
import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Console, Context, Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { Boxes } from "./dist/box/manager.js";
import { spendRoutes } from "./dist/box/spend-http.js";
import { SpendLedger } from "./dist/box/spend-ledger.js";
const [, file, fixtureBearer] = process.argv;
const unused = () => Effect.die("Unexpected lifecycle action");
const boxes = Layer.succeed(Boxes, Boxes.of({
  act: unused, create: unused, inspect: unused, tail: unused,
  ownerAt: () => Effect.succeed({ peonId: "browser-a", imageKey: "browser" }),
}));
const server = Layer.fresh(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }));
const processLife = Effect.gen(function* () {
  const started = yield* HttpRouter.serve(spendRoutes(Redacted.make(fixtureBearer)), { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(boxes),
    Layer.provide(SpendLedger.layer(file, { browser: { dailyTokens: 1000, ratePerMin: 20 } }, () => Effect.void)),
    Layer.provideMerge(server),
    Layer.build
  );
  yield* Console.log(HttpServer.formatAddress(Context.get(started, HttpServer.HttpServer).address));
  yield* Effect.never;
});
NodeRuntime.runMain(processLife.pipe(Effect.scoped));
`;

it.live(
  "both real proxy listeners share one file-backed budget after SIGKILL of the manager mid-stream",
  () =>
    Effect.gen(function* sharedLedger() {
      const fs = yield* FileSystem.FileSystem;

      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "shared-spend-",
      });

      const key = Redacted.make("fixture-manager-bearer");
      const releaseUpstream = yield* Deferred.make<true>();
      const checkpointed = yield* Deferred.make<true>();
      const upstreamCalls = yield* Ref.make(0);

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const transport = yield* HttpClient.HttpClient;

      const startManager = Effect.gen(function* startManager() {
        const child = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              managerFixture,
              `${dir}/spend.sqlite`,
              Redacted.value(key),
            ],
            { extendEnv: false }
          )
        );

        const origin = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
          Effect.flatMap(Effect.fromOption),
          Effect.timeout("5 seconds")
        );

        const client = transport.pipe(
          HttpClient.mapRequestInput((request) =>
            HttpClientRequest.setUrl(
              request,
              new URL(new URL(request.url).pathname, origin).href
            )
          )
        );

        return { client, child };
      });

      const first = yield* startManager;
      const active = yield* Ref.make(first.client);

      const manager = HttpClient.make((request) =>
        Ref.get(active).pipe(
          Effect.flatMap((client) => client.execute(request)),
          Effect.tap(() =>
            Effect.gen(function* detectCheckpoint() {
              if (
                new URL(request.url).pathname === RECORD_PATH &&
                (yield* Ref.get(upstreamCalls)) === 3
              ) {
                yield* Deferred.succeed(checkpointed, true);
              }
            })
          )
        )
      );

      const upstream = HttpClient.make((request) =>
        Effect.gen(function* fakeProvider() {
          const index = yield* Ref.updateAndGet(
            upstreamCalls,
            (calls) => calls + 1
          );

          const prefix = Stream.make(
            'data: {"type":"response.output_text.delta","delta":"first chunk"}\n\n'
          );

          const chunks =
            index === 3
              ? prefix.pipe(
                  Stream.concat(
                    Stream.fromEffect(
                      Deferred.await(releaseUpstream).pipe(
                        Effect.as(completed(100))
                      )
                    )
                  )
                )
              : Stream.make(completed(index === 1 ? 200 : 300));

          const bytes = yield* Stream.toReadableStreamEffect(
            chunks.pipe(Stream.encodeText)
          );

          return HttpClientResponse.fromWeb(
            request,
            new Response(bytes, {
              headers: { "content-type": "text/event-stream" },
            })
          );
        })
      );

      const config = {
        key: Redacted.make("fixture-upstream-bearer"),
        models: ["gpt-6.1-sol", "claude-opus-5-5"],
        upstream: "http://provider.example.invalid",
      };

      const provider = Layer.succeed(HttpClient.HttpClient, upstream);

      const full = Context.get(
        yield* HttpRouter.serve(fullProxyRoutes, server).pipe(
          Layer.provide(
            FullProxy.layer({
              ...config,
              spend: modelSpend(manager, key, false),
            }).pipe(Layer.provide(provider))
          ),
          Layer.provideMerge(Layer.fresh(NodeHttpServer.layerTest)),
          Layer.build
        ),
        HttpClient.HttpClient
      );

      const restricted = Context.get(
        yield* HttpRouter.serve(proxyRoutes, server).pipe(
          Layer.provide(
            Proxy.layer({
              ...config,
              spend: modelSpend(manager, key, true),
            }).pipe(Layer.provide(provider))
          ),
          Layer.provideMerge(Layer.fresh(NodeHttpServer.layerTest)),
          Layer.build
        ),
        HttpClient.HttpClient
      );

      expect(
        yield* call(full, 200).pipe(Effect.flatMap((response) => response.text))
      ).toBe(completed(200));
      expect(
        yield* call(restricted, 300).pipe(
          Effect.flatMap((response) => response.text)
        )
      ).toBe(completed(300));
      const outstanding = yield* call(full, 350);
      expect(outstanding.status).toBe(200);
      yield* Deferred.await(checkpointed);
      yield* first.child.kill({ killSignal: "SIGKILL" });
      yield* first.child.exitCode.pipe(Effect.ignore);
      const restarted = yield* startManager;
      yield* Ref.set(active, restarted.client);

      const deniedWhileHeld = yield* call(restricted, 170);
      expect(deniedWhileHeld.status).toBe(429);
      expect(yield* deniedWhileHeld.text).toContain("SpendCap");
      yield* Deferred.succeed(releaseUpstream, true);
      expect(yield* outstanding.text).toContain(completed(100));

      expect(
        yield* call(restricted, 350).pipe(
          Effect.flatMap((response) => response.text)
        )
      ).toBe(completed(300));
      const deniedAfterRefund = yield* call(full, 150);
      expect(deniedAfterRefund.status).toBe(429);
      expect(yield* deniedAfterRefund.text).toContain("SpendCap");
      expect(yield* Ref.get(upstreamCalls)).toBe(4);
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
      Effect.provideService(Tracer.DisablePropagation, true)
    )
);
