import { gzipSync, gunzipSync } from "node:zlib";

import { expect, it } from "@effect/vitest";
import { Effect, Layer, Match, Option, Redacted, Ref, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { Proxy, proxyRoute, proxyRoutes } from "../src/proxy.js";
import { capturedBody, capturedHeaders } from "./messages-fixture.js";

it.effect.prop(
  "the Messages recipient path accepts captured Claude Code shapes, swaps only credentials and preserves prompts, headers and streaming bytes",
  { compressed: Arbitrary.schema(Schema.Boolean) },
  ({ compressed }) =>
    Effect.gen(function* recipientPath() {
      const seen = yield* Ref.make<HttpClientRequest.HttpClientRequest[]>([]);
      const sse = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
      const bytes = compressed ? gzipSync(sse) : new TextEncoder().encode(sse);

      const plainHeaders = {
        "anthropic-ratelimit-requests-remaining": "7",
        "content-length": String(bytes.byteLength),
        "content-type": "text/event-stream",
        "request-id": "fixture-request",
      };

      const responseHeaders = compressed
        ? { ...plainHeaders, "content-encoding": "gzip" }
        : plainHeaders;

      const client = HttpClient.make((request) =>
        Ref.update(seen, (requests) => [...requests, request]).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(bytes, {
                headers: {
                  ...responseHeaders,
                  connection: "keep-alive",
                  "keep-alive": "timeout=5",
                  "transfer-encoding": "chunked",
                  "x-other-header": "not-forwarded",
                },
              })
            )
          )
        )
      );

      const services = yield* Layer.build(
        Proxy.layer({
          key: Redacted.make("host-only-key"),
          models: ["claude-opus-5-5", "gpt-6.1-sol"],
          upstream: "http://192.0.2.2",
        }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))
      );

      const handler = yield* HttpRouter.toHttpEffect(proxyRoutes);

      const post = (
        path: string,
        body: string,
        headers: Readonly<Record<string, string>>
      ) =>
        handler.pipe(
          Effect.provide(services),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`http://192.0.2.1${path}`, {
                body,
                headers,
                method: "POST",
              })
            )
          ),
          Effect.map((response) => HttpServerResponse.toWeb(response))
        );

      const rawBody = JSON.stringify(capturedBody, null, 2);

      const headers = {
        ...capturedHeaders,
        "content-length": String(new TextEncoder().encode(rawBody).byteLength),
      };

      for (const path of ["/v1/messages", "/v1/messages?beta=true"]) {
        const response = yield* post(path, rawBody, headers);

        const received = new Uint8Array(
          yield* Effect.promise(response.arrayBuffer.bind(response))
        );

        const reply = new TextDecoder().decode(
          response.headers.get("content-encoding") === "gzip"
            ? gunzipSync(received)
            : received
        );

        expect(response.status, reply).toBe(200);
        expect(reply).toBe(sse);
        expect(received).toEqual(new Uint8Array(bytes));
        expect(Object.fromEntries(response.headers)).toEqual(responseHeaders);
      }

      const requests = yield* Ref.get(seen);
      expect(requests).toHaveLength(2);

      for (const [index, request] of requests.entries()) {
        expect(HttpClientRequest.toUrl(request)).toEqual(
          Option.some(
            new URL(
              `http://192.0.2.2/v1/messages${index === 0 ? "" : "?beta=true"}`
            )
          )
        );
        expect(request.headers).toEqual({
          ...headers,
          authorization: "Bearer host-only-key",
        });

        const body = Match.value(request.body).pipe(
          Match.tag("Uint8Array", (value) =>
            new TextDecoder().decode(value.body)
          ),
          Match.orElse(() => "")
        );

        expect(body).toBe(rawBody);
      }

      for (const changed of [
        {
          headers: {
            ...capturedHeaders,
            "anthropic-beta": `${capturedHeaders["anthropic-beta"]},extra-beta`,
          },
        },
        { headers: { ...capturedHeaders, "x-extra-header": "enabled" } },
        { body: { ...capturedBody, extra_body_key: true } },
        {
          body: {
            ...capturedBody,
            tools: [{ ...capturedBody.tools[0], type: "web_search_20250305" }],
          },
        },
        {
          body: {
            ...capturedBody,
            tools: [
              {
                description: "Other tool",
                input_schema: {},
                name: "mcp__other-server__read",
              },
            ],
          },
        },
        {
          body: {
            ...capturedBody,
            tools: [
              {
                ...capturedBody.tools[5],
                input_schema: { properties: { injected: {} }, type: "object" },
              },
            ],
          },
        },
        {
          body: {
            ...capturedBody,
            tools: [
              { ...capturedBody.tools[5], description: "changed placeholder" },
            ],
          },
        },
        { body: { ...capturedBody, model: "gpt-6.1-sol" } },
        { body: { ...capturedBody, model: "claude-sonnet-5" } },
        {
          body: {
            ...capturedBody,
            output_config: { effort: "xhigh", speed: "fast" },
          },
        },
        { body: { ...capturedBody, speed: "fast" } },
        {
          body: {
            ...capturedBody,
            metadata: { extra: true, user_id: "fixture" },
          },
        },
        {
          body: {
            ...capturedBody,
            tool_choice: { name: "web_search", type: "tool" },
          },
        },
        {
          body: { ...capturedBody, tool_choice: { extra: true, type: "auto" } },
        },
        { body: { ...capturedBody, temperature: 2 } },
      ]) {
        const response = yield* post(
          "/v1/messages?beta=true",
          JSON.stringify(changed.body ?? capturedBody),
          changed.headers ?? capturedHeaders
        );

        expect(response.status, JSON.stringify(changed)).toBe(403);
      }

      expect(yield* Ref.get(seen)).toHaveLength(2);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "Messages keeps Claude Code's supported tool_choice and temperature without enabling other tools",
  {
    choice: Arbitrary.schema(
      Schema.Union([
        Schema.Struct({
          disable_parallel_tool_use: Schema.Boolean,
          type: Schema.Literals(["auto", "any", "none"]),
        }),
        Schema.Struct({
          name: Schema.Literals([
            "mcp__custom-tools__read",
            "mcp__custom-tools__grep",
            "mcp__custom-tools__find",
            "mcp__custom-tools__ls",
            "mcp__custom-tools__bash",
          ]),
          type: Schema.Literal("tool"),
        }),
      ])
    ),
    temperature: Arbitrary.schema(
      Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }))
    ),
  },
  ({ choice, temperature }) =>
    Effect.gen(function* supportedOptions() {
      const response = yield* Proxy.use(({ forward }) =>
        forward({
          body: { ...capturedBody, temperature, tool_choice: choice },
          headers: capturedHeaders,
          target: "/v1/messages",
        })
      ).pipe(
        Effect.provide(
          Proxy.layer({
            key: Redacted.make("host-only-key"),
            models: ["gpt-6.1-sol", "claude-opus-5-5"],
            upstream: "http://192.0.2.2",
          })
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("ok"))
            )
          )
        )
      );

      expect(response.status).toBe(200);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "raw Messages targets admit only no query or exactly beta=true before forwarding",
  {
    target: Arbitrary.schema(
      Schema.Literals([
        "/v1/messages?",
        "/v1/messages?beta=false",
        "/v1/messages?beta=true&extra=1",
        "/v1/messages?beta=true&beta=true",
        "/v1/messages/",
        "/v1/%6dessages",
        "/v1/messages#fragment",
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
            new Request("http://192.0.2.1/v1/messages", {
              body: JSON.stringify(capturedBody),
              method: "POST",
            })
          ).modify({ url: target })
        ),
        Effect.provideService(
          Proxy,
          Proxy.of({
            forward: () =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.andThen(Effect.die("Invalid target reached upstream"))
              ),
          })
        )
      );

      expect(response.status).toBe(400);
      expect(yield* Ref.get(calls)).toBe(0);
    }).pipe(Effect.scoped)
);
