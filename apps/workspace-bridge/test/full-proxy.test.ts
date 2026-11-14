import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Stream,
  Tracer,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";

import { FullProxy, fullProxyRoutes } from "../src/full-proxy.js";

it.effect(
  "full model HTTP routes swap both keys and preserve beta headers, arbitrary fields, full tools and streaming bytes",
  () =>
    Effect.gen(function* passthrough() {
      const captured = yield* Ref.make<HttpClientRequest.HttpClientRequest[]>(
        []
      );

      const stream = "event: message_start\ndata: {}\n\n";

      const upstream = HttpClient.make((request) =>
        Ref.update(captured, (requests) => [...requests, request]).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(stream, {
                headers: { "content-type": "text/event-stream" },
              })
            )
          )
        )
      );

      yield* HttpRouter.serve(fullProxyRoutes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(
          FullProxy.layer({
            key: Redacted.make("host-only-secret"),
            models: ["gpt-6.1-sol", "claude-opus-5-5"],
            upstream: "http://192.0.2.1",
          }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, upstream)))
        ),
        Layer.build
      );

      const body = {
        background: true,
        model: "claude-opus-5-5",
        tools: [
          { name: "write", parameters: {}, type: "function" },
          { type: "web_search" },
        ],
      };

      const response = yield* HttpClient.post("/v1/messages?beta=true", {
        body: HttpBody.jsonUnsafe(body),
        headers: {
          "anthropic-beta": "interleaved-thinking-2025-05-14",
          authorization: "Bearer box-placeholder",
          "x-api-key": "box-api-placeholder",
          "x-future-feature": "enabled",
        },
      });

      expect(response.status).toBe(200);
      expect(yield* response.text).toBe(stream);
      const requests = yield* Ref.get(captured);
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request?.headers).toMatchObject({
        "anthropic-beta": "interleaved-thinking-2025-05-14",
        authorization: "Bearer host-only-secret",
        "x-api-key": "host-only-secret",
        "x-future-feature": "enabled",
      });
      expect(
        request === undefined ? Option.none() : HttpClientRequest.toUrl(request)
      ).toEqual(Option.some(new URL("http://192.0.2.1/v1/messages?beta=true")));
      expect(request?.body._tag).toBe("Uint8Array");

      if (request?.body._tag === "Uint8Array") {
        expect(new TextDecoder().decode(request.body.body)).toBe(
          JSON.stringify(body)
        );
      }

      const codex = yield* HttpClient.post("/v1/responses", {
        body: HttpBody.jsonUnsafe({
          model: "gpt-6.1-sol",
          tools: [{ name: "apply_patch", type: "custom" }],
        }),
      });

      expect(codex.status).toBe(200);
      expect(yield* codex.text).toBe(stream);

      for (const model of ["not-approved", "", null, 123]) {
        const refused = yield* HttpClient.post("/v1/responses", {
          body: HttpBody.jsonUnsafe({ model }),
        });

        expect(refused.status).toBe(403);
      }

      expect(yield* Ref.get(captured)).toHaveLength(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeHttpServer.layerTest),
      Effect.provideService(Tracer.DisablePropagation, true)
    )
);

it.effect.prop(
  "credential replacement holds for arbitrary caller keys without filtering feature headers",
  {
    caller: Arbitrary.schema(Schema.String),
    key: Arbitrary.schema(Schema.String),
  },
  ({ key, caller }) =>
    Effect.gen(function* keySwap() {
      const seen = yield* Ref.make<Readonly<Record<string, string>>>({});

      const upstream = HttpClient.make((request) =>
        Ref.set(seen, request.headers).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response("ok")))
        )
      );

      const hostKey = `host-${new TextEncoder().encode(key).join("-")}`;
      yield* FullProxy.use(({ forward }) =>
        forward({
          body: { arbitrary: true, model: "gpt-6.1-sol" },
          headers: {
            Authorization: caller,
            "X-Api-Key": caller,
            "anthropic-beta": "all-tools",
          },
          target: "/v1/responses",
        }).pipe(Effect.flatMap((response) => Stream.runDrain(response.body)))
      ).pipe(
        Effect.scoped,
        Effect.provide(
          FullProxy.layer({
            key: Redacted.make(hostKey),
            models: ["gpt-6.1-sol"],
            upstream: "http://192.0.2.2",
          })
        ),
        Effect.provideService(HttpClient.HttpClient, upstream)
      );
      expect(yield* Ref.get(seen)).toMatchObject({
        "anthropic-beta": "all-tools",
        authorization: `Bearer ${hostKey}`,
        "x-api-key": hostKey,
      });
    })
);

it.effect(
  "eight streamed calls hold their slots until scope completion and the ninth gets a retryable overload",
  () =>
    Effect.gen(function* slots() {
      const release = yield* Deferred.make<boolean>();
      const entered = yield* Deferred.make<boolean>();
      const count = yield* Ref.make(0);

      const upstream = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("stream"))
        )
      );

      yield* Effect.gen(function* operations() {
        const proxy = yield* FullProxy;

        const fibers = yield* Effect.forEach(
          Array.from({ length: 8 }, () => 0),
          () =>
            Effect.forkChild(
              Effect.scoped(
                proxy
                  .forward({
                    body: { model: "gpt-6.1-sol" },
                    headers: {},
                    target: "/v1/responses",
                  })
                  .pipe(
                    Effect.andThen(
                      Ref.updateAndGet(count, (value) => value + 1)
                    ),
                    Effect.tap((value) =>
                      value === 8
                        ? Deferred.succeed(entered, true)
                        : Effect.void
                    ),
                    Effect.andThen(Deferred.await(release))
                  )
              )
            )
        );

        yield* Deferred.await(entered);
        expect(
          (yield* Effect.flip(
            Effect.scoped(
              proxy.forward({
                body: { model: "gpt-6.1-sol" },
                headers: {},
                target: "/v1/responses",
              })
            )
          )).status
        ).toBe(503);
        yield* Deferred.succeed(release, true);
        yield* Effect.all(fibers.map((fiber) => Fiber.join(fiber)));
        expect(
          (yield* Effect.scoped(
            proxy.forward({
              body: { model: "gpt-6.1-sol" },
              headers: {},
              target: "/v1/responses",
            })
          )).status
        ).toBe(200);
      }).pipe(
        Effect.provide(
          FullProxy.layer({
            key: Redacted.make("host-key"),
            models: ["gpt-6.1-sol"],
            upstream: "http://192.0.2.3",
          })
        ),
        Effect.provideService(HttpClient.HttpClient, upstream)
      );
    }).pipe(Effect.scoped)
);
