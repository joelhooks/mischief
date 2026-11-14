import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Ref } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { Proxy } from "../src/proxy.js";
import { capturedBody, capturedHeaders } from "./messages-fixture.js";

it.effect(
  "the production Messages Node transport preserves captured headers without Fetch metadata, trace headers or rewritten prompts",
  () =>
    Effect.gen(function* transport() {
      const seen = yield* Ref.make<Readonly<Record<string, string>>[]>([]);
      const bodies = yield* Ref.make<string[]>([]);

      const route = HttpRouter.add(
        "POST",
        "/v1/messages",
        Effect.gen(function* upstream() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const body = yield* request.text;
          yield* Ref.update(seen, (requests) => [...requests, request.headers]);
          yield* Ref.update(bodies, (requests) => [...requests, body]);

          return HttpServerResponse.text("event: message_stop\ndata: {}\n\n", {
            contentType: "text/event-stream",
          });
        })
      );

      yield* HttpRouter.serve(route, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const endpoint = yield* client.preprocess(HttpClientRequest.get(""));
      const messagesContext = yield* Layer.build(NodeHttpClient.layerNodeHttp);

      const messagesClient = Context.get(
        messagesContext,
        HttpClient.HttpClient
      );

      const rawBody = JSON.stringify(capturedBody, null, 2);

      const headers = {
        ...capturedHeaders,
        "content-length": String(new TextEncoder().encode(rawBody).byteLength),
      };

      const reply = yield* Proxy.use(({ forward }) =>
        forward({
          body: capturedBody,
          headers,
          rawBody,
          target: "/v1/messages?beta=true",
        })
      ).pipe(
        Effect.provide(
          Proxy.layer(
            {
              key: Redacted.make("host-only-key"),
              models: ["gpt-6.1-sol", "claude-opus-5-5"],
              upstream: endpoint.url,
            },
            messagesClient
          )
        )
      );

      expect(reply.status).toBe(200);
      expect(yield* Ref.get(seen)).toEqual([
        { ...headers, authorization: "Bearer host-only-key" },
      ]);
      expect(yield* Ref.get(bodies)).toEqual([rawBody]);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest))
);
