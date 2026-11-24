import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Ref,
  Schema,
  Stream,
  Tracer,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { uuidV4Unsafe } from "effect/crypto/SecureRandom";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "effect/http";
import { TestClock } from "effect/testing";

import { boxManagerRoutes } from "../src/box/http.js";
import { liveBoxId } from "../src/box/live-owner.js";
import { Boxes } from "../src/box/manager.js";
import { SpendLedger } from "../src/box/spend-ledger.js";
import { ADMIT_PATH, RECORD_PATH } from "../src/box/spend-protocol.js";
import { FullProxy, fullProxyRoutes } from "../src/full-proxy.js";
import { managerKey, meterResponse, modelSpend } from "../src/model-spend.js";
import { refusal } from "../src/protocol.js";
import { Proxy, proxyRoutes } from "../src/proxy.js";

const frame = (body: Schema.Json) => `data: ${JSON.stringify(body)}\r\n\r\n`;

const completed = frame({
  type: "response.completed",
  response: {
    usage: { input_tokens: 700, output_tokens: 300, total_tokens: 1000 },
  },
});

for (const surface of ["full", "restricted"] as const) {
  it.effect(
    `${surface} proxy charges the real socket's box, not spoofed headers, and refuses the next call at 100%`,
    () =>
      Effect.gen(function* socketSpend() {
        const client = yield* HttpClient.HttpClient;
        const controlKey = Redacted.make(uuidV4Unsafe());
        const spendValue = uuidV4Unsafe();

        const spendKey = yield* managerKey.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnvRecord({
                MISCHIEF_BOX_SPEND_KEY: spendValue,
              })
            )
          )
        );

        const manager = client.pipe(
          HttpClient.mapRequestInput((request) =>
            HttpClientRequest.setUrl(request, new URL(request.url).pathname)
          )
        );

        const called = yield* Ref.make(0);

        const upstream = HttpClient.make((request) =>
          Ref.update(called, (count) => count + 1).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                new Response(completed, {
                  headers: { "content-type": "text/event-stream" },
                })
              )
            )
          )
        );

        const config = {
          key: Redacted.make(uuidV4Unsafe()),
          models: ["gpt-6.1-sol", "claude-opus-5-5"],
          spend: modelSpend(manager, spendKey, surface === "restricted"),
          upstream: "http://provider.example.invalid",
        };

        const provider = Layer.succeed(HttpClient.HttpClient, upstream);

        const inventory = JSON.stringify({
          first: { IPv4Address: "127.0.0.1/8", Name: "mischief-peon-box-real" },
          second: {
            IPv4Address: "192.0.2.10/24",
            Name: "mischief-peon-box-forged",
          },
        });

        const boxes = Layer.succeed(
          Boxes,
          Boxes.of({
            act: () => Effect.die("Unexpected lifecycle action"),
            create: () => Effect.die("Unexpected box creation"),
            inspect: () => Effect.die("Unexpected box inspection"),
            tail: () => Effect.die("Unexpected session tail"),
            ownerAt: Effect.fnUntraced(function* ownerAt(peer) {
              const peonId = yield* liveBoxId(inventory, peer);

              if (peonId === undefined) {
                return yield* refusal("No box in fixture inventory", 403);
              }

              return {
                imageKey: peonId === "real" ? "browser" : "full",
                peonId,
              } as const;
            }),
          })
        );

        const ledger = SpendLedger.layer(
          ":memory:",
          {
            browser: {
              dailyTokens: 1000,
              defaultOutputTokens: 128,
              ratePerMin: 2,
            },
          },
          () => Effect.void
        );

        const managerRoutes = boxManagerRoutes({
          controlKey,
          spendKey: Redacted.make(spendValue),
        });

        const server = { disableListenLog: true, disableLogger: true };

        const proxy =
          surface === "full"
            ? HttpRouter.serve(
                Layer.merge(fullProxyRoutes, managerRoutes),
                server
              ).pipe(
                Layer.provide(
                  FullProxy.layer(config).pipe(Layer.provide(provider))
                )
              )
            : HttpRouter.serve(
                Layer.merge(proxyRoutes, managerRoutes),
                server
              ).pipe(
                Layer.provide(Proxy.layer(config).pipe(Layer.provide(provider)))
              );

        yield* proxy.pipe(
          Layer.provide(boxes),
          Layer.provide(ledger),
          Layer.build
        );

        const forged = yield* client.post(ADMIT_PATH, {
          body: HttpBody.jsonUnsafe({ peer: "192.0.2.10", tokens: 0 }),
        });

        expect(forged.status).toBe(401);
        yield* forged.text;

        const forbiddenSpawn = yield* client.post("/v1/boxes", {
          headers: { authorization: `Bearer ${spendValue}` },
        });

        expect(forbiddenSpawn.status).toBe(401);
        yield* forbiddenSpawn.text;

        for (const path of [ADMIT_PATH, RECORD_PATH]) {
          const forbiddenSpend = yield* client.post(path, {
            headers: {
              authorization: `Bearer ${Redacted.value(controlKey)}`,
            },
          });

          expect(forbiddenSpend.status, path).toBe(401);
          yield* forbiddenSpend.text;
        }

        if (surface === "full") {
          const background = yield* client.post("/v1/responses", {
            body: HttpBody.jsonUnsafe({
              background: true,
              model: "gpt-6.1-sol",
            }),
          });

          expect(background.status).toBe(403);
          yield* background.text;
          expect(yield* Ref.get(called)).toBe(0);
        }

        const post = () =>
          client.post("/v1/responses", {
            body: HttpBody.jsonUnsafe({
              input: [],
              model: "gpt-6.1-sol",
              stream: true,
            }),
            headers: {
              "x-forwarded-for": "192.0.2.10",
              "x-mischief-peon-id": "forged",
            },
          });

        const first = yield* post();
        expect(first.status).toBe(200);
        expect(yield* first.text).toBe(completed);
        const capped = yield* post();
        expect(capped.status).toBe(429);

        const error = yield* capped.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                error: Schema.Struct({
                  code: Schema.String,
                  message: Schema.String,
                }),
              })
            )
          )
        );

        expect(error.error.code).toBe("SpendCap");
        expect(error.error.message).toContain("HTTP 429");
        expect(yield* Ref.get(called)).toBe(1);
      }).pipe(
        Effect.provide(NodeHttpServer.layerTest),
        Effect.provideService(Tracer.DisablePropagation, true)
      )
  );
}

it.effect(
  "browser peers use managed admission, not the workspace exemption",
  () =>
    Effect.gen(function* browserSpend() {
      const unexpected = HttpClient.make(() =>
        Effect.die("Admission must not call the manager without a key")
      );

      const withoutManager = modelSpend(unexpected, undefined, true);

      expect(yield* withoutManager("::ffff:172.30.211.7", 32)).toBeUndefined();

      for (const peer of [
        "172.30.213.7",
        "172.30.213.1",
        "172.30.211.1",
        "192.0.2.7",
      ]) {
        expect((yield* Effect.flip(withoutManager(peer, 32))).status).toBe(403);
      }

      const manager = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              outputTokens: 80,
              receipt: uuidV4Unsafe(),
              status: "metered",
            })
          )
        )
      );

      for (const restricted of [true, false]) {
        const admit = modelSpend(manager, Redacted.make("fixture"), restricted);
        expect(yield* admit("::ffff:172.30.213.7", 32)).toMatchObject({
          outputTokens: 80,
        });
      }
    })
);

it.effect(
  "maps only a unique network endpoint with a managed name (including IPv4-mapped sockets)",
  () =>
    Effect.gen(function* liveIdentity() {
      const owner = {
        IPv4Address: "192.0.2.5/24",
        Name: "mischief-peon-box-browser-a",
      };

      const unrelated = {
        IPv4Address: "192.0.2.6/24",
        Name: "other-container",
      };

      const inventory = JSON.stringify({ first: owner, second: unrelated });
      expect(yield* liveBoxId(inventory, "::ffff:192.0.2.5")).toBe("browser-a");
      expect(yield* liveBoxId(inventory, "192.0.2.6")).toBeUndefined();
      expect(yield* liveBoxId(inventory, "192.0.2.7")).toBeUndefined();
      expect(
        yield* liveBoxId(
          JSON.stringify({ first: owner, duplicate: owner }),
          "192.0.2.5"
        )
      ).toBeUndefined();
    })
);

it.effect.prop(
  "counts Messages input/cache and cumulative output exactly once across arbitrary stream splits",
  {
    size: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))
    ),
  },
  ({ size }) =>
    Effect.gen(function* splitMessages() {
      const wire = new TextEncoder().encode(
        [
          frame({
            type: "message_start",
            message: {
              usage: {
                input_tokens: 500,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 100,
                output_tokens: 1,
              },
            },
          }),
          frame({ type: "content_block_delta", delta: { text: "🐀" } }),
          frame({ type: "message_delta", usage: { output_tokens: 300 } }),
          frame({ type: "message_delta", usage: { output_tokens: 300 } }),
        ].join("")
      );

      const chunks = Array.from(
        { length: Math.ceil(wire.length / size) },
        (_, index) => wire.subarray(index * size, (index + 1) * size)
      );

      const readings = yield* Ref.make<number[]>([]);

      const metered = meterResponse(
        {
          record: (tokens, settled) =>
            settled
              ? Effect.void
              : Ref.update(readings, (values) => [...values, tokens]),
        },
        80,
        "text/event-stream",
        Stream.fromIterable(chunks)
      );

      expect(Buffer.concat(yield* Stream.runCollect(metered))).toEqual(
        Buffer.from(wire)
      );
      const charges = yield* Ref.get(readings);
      expect(charges.at(-1)).toBe(1000);
      expect(charges.filter((charge) => charge === 1000)).toHaveLength(1);
    })
);

for (const scenario of ["restart", "persistent"] as const) {
  it.effect(
    `model admission stays closed during a ${scenario} manager outage`,
    () =>
      Effect.gen(function* admissionOutage() {
        const client = yield* HttpClient.HttpClient;
        const started = yield* Deferred.make<true>();
        const available = yield* Ref.make(false);
        const calls = yield* Ref.make(0);

        const manager = HttpClient.make((request) =>
          Effect.gen(function* managerReply() {
            yield* Deferred.succeed(started, true);

            if (yield* Ref.get(available)) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ status: "uncapped" })
              );
            }

            if (scenario === "restart") {
              return yield* new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error("fixture connection refused"),
                }),
              });
            }

            return HttpClientResponse.fromWeb(
              request,
              new Response("Manager unavailable", { status: 503 })
            );
          })
        );

        const upstream = HttpClient.make((request) =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(request, Response.json({ ok: true }))
            )
          )
        );

        const config = {
          key: Redacted.make("fixture-upstream-bearer"),
          models: ["gpt-6.1-sol"],
          spend: modelSpend(
            manager,
            Redacted.make("fixture-manager-bearer"),
            false
          ),
          upstream: "http://provider.example.invalid",
        };

        yield* HttpRouter.serve(fullProxyRoutes, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provide(
            FullProxy.layer(config).pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, upstream))
            )
          ),
          Layer.build
        );

        const prompt = yield* client
          .post("/v1/responses", {
            body: HttpBody.jsonUnsafe({ input: [], model: "gpt-6.1-sol" }),
          })
          .pipe(Effect.forkScoped);

        yield* Deferred.await(started);
        yield* TestClock.adjust(
          scenario === "restart" ? "5 seconds" : "14 seconds"
        );
        expect(yield* Ref.get(calls)).toBe(0);
        expect(prompt.pollUnsafe()).toBeUndefined();

        if (scenario === "restart") {
          yield* Ref.set(available, true);
        }

        yield* TestClock.adjust("1 second");

        const finished = yield* TestClock.withLive(
          Fiber.join(prompt).pipe(Effect.timeout("1 second"), Effect.exit)
        );

        if (Exit.isFailure(finished)) {
          yield* TestClock.adjust("10 seconds");
        }

        const response = yield* finished;

        expect(response.status).toBe(scenario === "restart" ? 200 : 503);
        expect(yield* Ref.get(calls)).toBe(scenario === "restart" ? 1 : 0);
        yield* response.text;
      }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );
}

it.effect(
  "manager timeout covers stalled success and error bodies after headers",
  () =>
    Effect.gen(function* stalledBodies() {
      const client = yield* HttpClient.HttpClient;
      const started = yield* Deferred.make<true>();
      const openBodies = yield* Ref.make(0);

      const bodyOpened = Ref.updateAndGet(
        openBodies,
        (count) => count + 1
      ).pipe(
        Effect.flatMap((count) =>
          count === 2
            ? Deferred.succeed(started, true).pipe(Effect.asVoid)
            : Effect.void
        )
      );

      const stall = (status: number) =>
        HttpServerResponse.stream(
          Stream.make(new TextEncoder().encode("{")).pipe(
            Stream.concat(
              Stream.fromEffect(bodyOpened.pipe(Effect.andThen(Effect.never)))
            )
          ),
          { status, contentType: "application/json" }
        );

      yield* HttpRouter.serve(
        Layer.merge(
          HttpRouter.add("POST", "/ok", stall(200)),
          HttpRouter.add("POST", "/err", stall(403))
        ),
        { disableListenLog: true, disableLogger: true }
      ).pipe(Layer.build);

      const attempts = yield* Effect.forEach(["/ok", "/err"], (path) =>
        Effect.forkScoped(
          modelSpend(
            HttpClient.mapRequestInput(client, (request) =>
              HttpClientRequest.setUrl(request, path)
            ),
            Redacted.make("fixture-manager-bearer"),
            false
          )("192.0.2.15", 12).pipe(Effect.flip)
        )
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust("5 seconds");
      const errors = yield* Effect.forEach(Fiber.join)(attempts);
      expect(errors.map((error) => error.status)).toEqual([503, 503]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
);

it.effect(
  "an SSE EOF without a provider completion does not refund the reservation",
  () =>
    Effect.gen(function* incompleteStream() {
      const transitions = yield* Ref.make<boolean[]>([]);

      const data = new TextEncoder().encode(
        frame({ type: "response.output_text.delta", delta: "unfinished" })
      );

      const stream = meterResponse(
        {
          record: (_tokens, settled) =>
            Ref.update(transitions, (seen) => [...seen, settled]),
        },
        8,
        "text/event-stream",
        Stream.make(data)
      );

      yield* Stream.runDrain(stream);
      expect(yield* Ref.get(transitions)).toEqual([false]);
    })
);

it.effect(
  "retains observed bytes when the upstream ends before sending any usage",
  () =>
    Effect.gen(function* missingUsage() {
      const latest = yield* Ref.make(0);
      const bytes = new TextEncoder().encode("data: partial ψ");

      const upstream = Stream.make(bytes).pipe(
        Stream.concat(Stream.fail("disconnected"))
      );

      const stream = meterResponse(
        { record: (tokens) => Ref.set(latest, tokens) },
        8,
        "text/event-stream",
        upstream
      );

      expect(yield* Effect.flip(Stream.runDrain(stream))).toBe("disconnected");
      expect(yield* Ref.get(latest)).toBe(6);
    })
);
