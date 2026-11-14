import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Effect,
  Layer,
  Logger,
  Predicate,
  Redacted,
  Ref,
  Result,
  Schema,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { Proxy } from "../src/proxy.js";
import { capturedBody, capturedHeaders } from "./messages-fixture.js";

const DisconnectableRequest = Schema.declare(
  (input): input is { readonly socket: { readonly destroy: () => void } } =>
    Predicate.hasProperty(input, "socket") &&
    Predicate.hasProperty(input.socket, "destroy") &&
    Predicate.isFunction(input.socket.destroy)
);

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
        connection: "upgrade",
        "content-length": "1",
        host: "192.0.2.1:28012",
        "keep-alive": "timeout=5",
        "proxy-connection": "keep-alive",
        te: "trailers",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
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
        {
          ...capturedHeaders,
          authorization: "Bearer host-only-key",
          connection: "close",
          "content-length": String(
            new TextEncoder().encode(rawBody).byteLength
          ),
          host: new URL(endpoint.url).host,
        },
      ]);
      expect(yield* Ref.get(bodies)).toEqual([rawBody]);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest))
);

it.effect(
  "TLS failures identify the protocol error without logging credentials or unbounded diagnostics",
  () =>
    Effect.gen(function* tlsFailure() {
      const logs: unknown[] = [];

      const logger = Logger.make(({ message }) => {
        logs.push(message);
      });

      const cause = Object.assign(
        new Error(
          `write EPROTO host-only-key Bearer inbound-secret api-key=other-secret https://user:password@192.0.2.2/path?token=secret ${"x".repeat(400)}`
        ),
        { code: "EPROTO" }
      );

      const messagesContext = yield* Layer.build(NodeHttpClient.layerNodeHttp);

      const messagesClient = Context.get(
        messagesContext,
        HttpClient.HttpClient
      );

      const client = HttpClient.make(() =>
        messagesClient
          .get("http://[")
          .pipe(Effect.mapError((failure) => Object.assign(failure, { cause })))
      );

      const failure = yield* Proxy.use(({ forward }) =>
        Effect.flip(
          forward({
            body: capturedBody,
            headers: capturedHeaders,
            target: "/v1/messages",
          })
        )
      ).pipe(
        Effect.provide(
          Proxy.layer(
            {
              key: Redacted.make("host-only-key"),
              models: ["gpt-6.1-sol", "claude-opus-5-5"],
              upstream: "https://192.0.2.2",
            },
            client
          )
        ),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(Logger.layer([logger]))
      );

      expect(failure.status).toBe(503);
      expect(failure.message).toContain("status unknown): TLS EPROTO");

      const [entry] = yield* Schema.decodeUnknownEffect(
        Schema.Tuple([
          Schema.Tuple([
            Schema.Struct({
              cause: Schema.String,
              event: Schema.Literal("peon_upstream_transport_error"),
              provider: Schema.Literal("claude-bridge/claude-opus-5-5"),
            }),
          ]),
        ])
      )(logs);

      expect(entry[0].cause).toMatch(
        /^Error: write EPROTO \[redacted\] Bearer \[redacted\] api-key=\[redacted\] \[redacted-url\] x+$/u
      );
      expect(entry[0].cause).toHaveLength(300);

      for (const secret of [
        "host-only-key",
        "inbound-secret",
        "other-secret",
        "password",
        "token=secret",
      ]) {
        expect(JSON.stringify(logs)).not.toContain(secret);
        expect(failure.message).not.toContain(secret);
      }
    }).pipe(Effect.scoped)
);

it.effect(
  "a failed Messages connection logs its transport cause and names it in the refusal",
  () =>
    Effect.gen(function* failedConnection() {
      const logs: { readonly level: string; readonly message: unknown }[] = [];

      const logger = Logger.make(({ logLevel, message }) => {
        logs.push({ level: logLevel, message });
      });

      const route = HttpRouter.add(
        "POST",
        "/v1/messages",
        Effect.gen(function* disconnect() {
          const request = yield* HttpServerRequest.HttpServerRequest;

          const incoming = yield* Schema.decodeUnknownEffect(
            DisconnectableRequest
          )(request.source);

          incoming.socket.destroy();

          return HttpServerResponse.empty();
        })
      );

      yield* HttpRouter.serve(route, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const endpoint = yield* client.preprocess(HttpClientRequest.get(""));
      const upstream = endpoint.url;
      const messagesContext = yield* Layer.build(NodeHttpClient.layerNodeHttp);

      const messagesClient = Context.get(
        messagesContext,
        HttpClient.HttpClient
      );

      const result = yield* Proxy.use(({ forward }) =>
        forward({
          body: capturedBody,
          headers: capturedHeaders,
          target: "/v1/messages",
        })
      ).pipe(
        Effect.provide(
          Proxy.layer(
            {
              key: Redacted.make("host-only-key"),
              models: ["gpt-6.1-sol", "claude-opus-5-5"],
              upstream,
            },
            messagesClient
          ).pipe(Layer.provideMerge(Logger.layer([logger])))
        ),
        Effect.provideService(HttpClient.HttpClient, messagesClient),
        Effect.result
      );

      expect(Result.isFailure(result)).toBe(true);

      if (Result.isFailure(result)) {
        expect(result.failure.status).toBe(503);
        expect(result.failure.message).toContain("status unknown): ECONNRESET");
      }

      expect(logs).toEqual([
        {
          level: "Warn",
          message: [
            {
              cause: "Error: socket hang up",
              event: "peon_upstream_transport_error",
              provider: "claude-bridge/claude-opus-5-5",
            },
          ],
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest))
);
