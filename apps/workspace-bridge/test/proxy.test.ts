import { gzipSync, gunzipSync } from "node:zlib";

import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import type { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Match,
  Redacted,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpClientRequest,
  HttpServerRequest,
} from "effect/http";
import { TestClock } from "effect/testing";

import { Proxy, proxyRoute, proxyRoutes } from "../src/proxy.js";
import { capturedBody, capturedHeaders } from "./messages-fixture.js";

const messagesInput = {
  body: capturedBody,
  headers: capturedHeaders,
  target: "/v1/messages?beta=true" as const,
};

const config = {
  key: Redacted.make("real-host-key"),
  models: ["gpt-6.1-sol", "claude-opus-5-5"],
  upstream: "http://provider.test/peons",
};

const input = {
  body: {
    input: [],
    model: "gpt-6.1-sol",
    tools: [{ name: "read", parameters: { type: "object" }, type: "function" }],
  },
  headers: {
    authorization: "Bearer proxy-placeholder",
    "user-agent": "pi/0.86.1",
  },
};

const text = (body: Stream.Stream<Uint8Array, BridgeFailure>) =>
  body.pipe(
    Stream.decodeText(),
    Stream.runCollect,
    Effect.map((parts) => parts.join(""))
  );

it.effect(
  "Responses proxy replaces credentials, preserves Pi headers and tools, and streams upstream SSE bytes",
  () =>
    Effect.gen(function* forwarding() {
      const seen = yield* Ref.make<HttpClientRequest.HttpClientRequest[]>([]);

      const sse =
        'event: content_block_start\ndata: {"type":"tool_use"}\n\nevent: message_stop\ndata: {}\n\n';

      const client = HttpClient.make((request) =>
        Ref.update(seen, (requests) => [...requests, request]).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(sse, {
                headers: { "content-type": "text/event-stream" },
              })
            )
          )
        )
      );

      const output = yield* Proxy.use(({ forward }) => forward(input)).pipe(
        Effect.provide(Proxy.layer(config)),
        Effect.provideService(HttpClient.HttpClient, client)
      );

      expect(yield* text(output.body)).toBe(sse);
      expect(output.contentType).toBe("text/event-stream");
      const requests = yield* Ref.get(seen);
      expect(requests).toHaveLength(1);
      const [request] = requests;

      if (request === undefined) {
        return yield* Effect.die("fake upstream did not receive a request");
      }

      expect(request.url).toBe("http://provider.test/peons/v1/responses");
      expect(request.headers).toMatchObject({
        authorization: "Bearer real-host-key",
        "user-agent": "pi/0.86.1",
        "x-cliproxy-client": "mischief/peons",
      });
      expect(request.headers).not.toHaveProperty("x-api-key");

      const body = Match.value(request.body).pipe(
        Match.tag("Uint8Array", (value) =>
          new TextDecoder().decode(value.body)
        ),
        Match.orElse(() => "")
      );

      expect(JSON.parse(body)).toEqual(input.body);
      expect(JSON.stringify(request.headers)).not.toContain(
        "proxy-placeholder"
      );

      return yield* Effect.void;
    }).pipe(Effect.scoped)
);

it.effect(
  "the proxy refuses path, method, model, malformed JSON and body size without calling upstream",
  () =>
    Effect.gen(function* refusals() {
      const calls = yield* Ref.make(0);

      const fake = Proxy.of({
        forward: () =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.as({
              body: Stream.empty,
              contentType: "text/event-stream",
              status: 200,
            })
          ),
      });

      yield* HttpRouter.serve(proxyRoutes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provide(Layer.succeed(Proxy, fake)), Layer.build);

      for (const [method, path] of [
        ["GET", "/v1/responses"],
        ["POST", "/v1/messages/other"],
        ["DELETE", "/"],
      ] as const) {
        const reply = yield* HttpClient.HttpClient.use((client) =>
          client.execute(HttpClientRequest.make(method)(path))
        );

        expect(reply.status).toBe(405);
        expect(yield* reply.text).toContain("Only POST /v1/responses");
      }

      const invalid = yield* HttpClient.post("/v1/responses", {
        body: HttpBody.text("{"),
      });

      expect(invalid.status).toBe(400);

      const large = yield* HttpClient.post("/v1/responses", {
        body: HttpBody.text("x".repeat(8 * 1024 * 1024 + 1)),
      });

      expect(large.status).toBe(413);
      expect(yield* Ref.get(calls)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest))
);

it.effect.prop(
  "raw Responses targets refuse fragments and every query before forwarding",
  {
    target: Arbitrary.schema(
      Schema.Literals([
        "/v1/responses?beta=true",
        "/v1/responses?x=1",
        "/v1/responses?",
        "/v1/responses/",
        "/v1/responses#fragment",
        "/v1/%72esponses",
        "/v1/other",
      ])
    ),
  },
  ({ target }) =>
    Effect.gen(function* rawTarget() {
      const calls = yield* Ref.make(0);

      const response = yield* proxyRoute.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://proxy.test/v1/messages", {
              body: JSON.stringify({ model: "gpt-6.1-sol" }),
              method: "POST",
            })
          ).modify({ url: target })
        ),
        Effect.provideService(
          Proxy,
          Proxy.of({
            forward: () =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.as({
                  body: Stream.empty,
                  contentType: "text/event-stream",
                  status: 200,
                })
              ),
          })
        )
      );

      expect(response.status).toBe(400);
      expect(yield* Ref.get(calls)).toBe(0);
    }).pipe(Effect.scoped)
);

it.effect("a nonallowlisted model is refused before any provider request", () =>
  Effect.gen(function* wrongModel() {
    const calls = yield* Ref.make(0);

    const client = HttpClient.make((request) =>
      Ref.update(calls, (count) => count + 1).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, new Response("")))
      )
    );

    const failure = yield* Proxy.use(({ forward }) =>
      Effect.flip(forward({ ...input, body: { model: "claude-opus-5-5" } }))
    ).pipe(
      Effect.provide(Proxy.layer(config)),
      Effect.provideService(HttpClient.HttpClient, client)
    );

    expect(failure.status).toBe(403);
    expect(failure.message).toContain("gpt-6.1-sol");
    expect(yield* Ref.get(calls)).toBe(0);
  }).pipe(Effect.scoped)
);

it.effect.prop(
  "429, 529, overloaded_error and unavailable responses retry only at 2s/4s/8s and stop after four attempts",
  {
    compressed: Arbitrary.schema(Schema.Boolean),
    messages: Arbitrary.schema(Schema.Boolean),
    status: Arbitrary.schema(Schema.Literals([429, 529, 500, 503])),
  },
  ({ status, messages, compressed }) =>
    Effect.gen(function* retry() {
      const gzipped = messages && compressed;
      const error = '{"error":{"type":"overloaded_error"}}';
      const calls = yield* Ref.make(0);
      const first = yield* Deferred.make<boolean>();

      const client = HttpClient.make((request) =>
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(first, true)),
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(gzipped ? gzipSync(error) : error, {
                headers: { "content-encoding": gzipped ? "gzip" : "identity" },
                status,
              })
            )
          )
        )
      );

      const fiber = yield* Effect.forkChild(
        Proxy.use(({ forward }) =>
          forward(messages ? messagesInput : input)
        ).pipe(
          Effect.provide(Proxy.layer(config)),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.scoped
        )
      );

      yield* Deferred.await(first);
      yield* TestClock.adjust(1999);
      expect(yield* Ref.get(calls)).toBe(1);
      yield* TestClock.adjust(1);
      expect(yield* Ref.get(calls)).toBe(2);
      yield* TestClock.adjust(3999);
      expect(yield* Ref.get(calls)).toBe(2);
      yield* TestClock.adjust(1);
      expect(yield* Ref.get(calls)).toBe(3);
      yield* TestClock.adjust(8000);
      const reply = yield* Fiber.join(fiber);
      expect(reply.status).toBe(status);
      expect(
        yield* text(
          reply.body.pipe(
            Stream.map((bytes) => (gzipped ? gunzipSync(bytes) : bytes))
          )
        )
      ).toBe(error);
      expect(yield* Ref.get(calls)).toBe(4);
    })
);

it.effect(
  "proxy admission counts streams until the request scope closes, rejects the ninth, and releases after cancellation",
  () =>
    Effect.gen(function* cap() {
      const gate = yield* Deferred.make<boolean>();
      const ready = yield* Deferred.make<boolean>();
      const calls = yield* Ref.make(0);

      const client = HttpClient.make((request) =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.tap((count) =>
            count === 8 ? Deferred.succeed(ready, true) : Effect.void
          ),
          Effect.as(HttpClientResponse.fromWeb(request, new Response("done")))
        )
      );

      yield* Effect.gen(function* shared() {
        const proxy = yield* Proxy;

        const fibers = yield* Effect.forEach(
          Array.from({ length: 8 }),
          (_, index) =>
            Effect.forkChild(
              Effect.scoped(
                proxy
                  .forward(index % 2 === 0 ? messagesInput : input)
                  .pipe(Effect.andThen(Deferred.await(gate)))
              )
            )
        );

        yield* Deferred.await(ready);
        const ninth = yield* Effect.flip(proxy.forward(messagesInput));
        expect(ninth.status).toBe(503);
        expect(yield* Ref.get(calls)).toBe(8);
        yield* Fiber.interrupt(
          fibers[0] ?? (yield* Effect.die("no first proxy fiber"))
        );
        const next = yield* Effect.scoped(proxy.forward(messagesInput));
        expect(next.status).toBe(200);
        yield* Deferred.succeed(gate, true);
        yield* Effect.forEach(fibers.slice(1), (fiber) => Fiber.join(fiber));
      }).pipe(
        Effect.provide(Proxy.layer(config)),
        Effect.provideService(HttpClient.HttpClient, client)
      );
    }).pipe(Effect.scoped)
);

it.effect(
  "once a successful stream starts, an error is not replayed upstream",
  () =>
    Effect.gen(function* streaming() {
      const calls = yield* Ref.make(0);
      const received = yield* Deferred.make<boolean>();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

      const client = HttpClient.make((request) =>
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream<Uint8Array>({
                  start(value) {
                    controller = value;
                    value.enqueue(new TextEncoder().encode("first SSE bytes"));
                  },
                })
              )
            )
          )
        )
      );

      const reply = yield* Proxy.use(({ forward }) => forward(input)).pipe(
        Effect.provide(Proxy.layer(config)),
        Effect.provideService(HttpClient.HttpClient, client)
      );

      const body = yield* Effect.forkChild(
        reply.body.pipe(
          Stream.tap(() => Deferred.succeed(received, true)),
          Stream.runCollect,
          Effect.result
        )
      );

      yield* Deferred.await(received);

      if (controller === undefined) {
        return yield* Effect.die("fake upstream did not start streaming");
      }

      controller.error(new Error("stream lost after first bytes"));
      expect(Result.isFailure(yield* Fiber.join(body))).toBe(true);
      expect(yield* Ref.get(calls)).toBe(1);

      return yield* Effect.void;
    }).pipe(Effect.scoped)
);
