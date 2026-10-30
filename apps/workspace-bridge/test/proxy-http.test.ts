import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Ref } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";

import { Proxy, proxyRoutes } from "../src/proxy.js";

it.effect(
  "the HTTP proxy drops placeholder credentials and connector requests, and returns the exact upstream stream",
  () =>
    Effect.gen(function* seam() {
      const seen = yield* Ref.make<Readonly<Record<string, string>>[]>([]);

      const bytes =
        'event: content_block_delta\ndata: {"partial_json":"{}"}\n\nevent: message_stop\ndata: {}\n\n';

      const upstream = HttpClient.make((request) =>
        Ref.update(seen, (headers) => [...headers, request.headers]).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(bytes, {
                headers: { "content-type": "text/event-stream" },
              })
            )
          )
        )
      );

      const proxy = Proxy.layer({
        key: Redacted.make("upstream-only-secret"),
        models: ["claude-opus-5-5"],
        upstream: "http://provider.test",
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, upstream)));

      yield* HttpRouter.serve(proxyRoutes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provide(proxy), Layer.build);

      const response = yield* HttpClient.post("/v1/messages", {
        body: HttpBody.jsonUnsafe({
          max_tokens: 128_000,
          messages: [],
          model: "claude-opus-5-5",
          stream: true,
          tools: [{ input_schema: { type: "object" }, name: "read" }],
        }),
        headers: {
          "anthropic-version": "test-version",
          authorization: "Bearer proxy-placeholder",
          "x-api-key": "proxy-placeholder",
        },
      });

      expect(response.status).toBe(200);
      expect(yield* response.text).toBe(bytes);
      expect(yield* Ref.get(seen)).toEqual([
        expect.objectContaining({
          "anthropic-version": "test-version",
          authorization: "Bearer upstream-only-secret",
          "x-api-key": "upstream-only-secret",
        }),
      ]);
      expect(JSON.stringify(yield* Ref.get(seen))).not.toContain(
        "proxy-placeholder"
      );

      expect((yield* Ref.get(seen))[0]).not.toHaveProperty("anthropic-beta");

      for (const beta of [
        "oauth-2025-04-20",
        "claude-code-20250219",
        "network-feature-2026-01-01",
        "fine-grained-tool-streaming-2025-05-14,network-feature-2026-01-01",
        "fine-grained-tool-streaming-2025-05-14,,inline-tools-2026-09-15",
      ]) {
        const refused = yield* HttpClient.post("/v1/messages", {
          body: HttpBody.jsonUnsafe({ model: "claude-opus-5-5" }),
          headers: { "anthropic-beta": beta },
        });

        expect(refused.status).toBe(403);
      }

      const query = yield* HttpClient.post("/v1/messages?other=route", {
        body: HttpBody.jsonUnsafe({ model: "claude-opus-5-5" }),
      });

      expect(query.status).toBe(400);

      for (const body of [
        { betas: ["inline-tools-2026-09-15"], model: "claude-opus-5-5" },
        {
          mcp_servers: [{ url: "https://outside.invalid" }],
          model: "claude-opus-5-5",
        },
        {
          model: "claude-opus-5-5",
          tools: [
            { input_schema: {}, name: "read", type: "web_search_20250305" },
          ],
        },
        {
          model: "claude-opus-5-5",
          tools: [{ input_schema: {}, name: "push" }],
        },
        { max_tokens: 128_001, model: "claude-opus-5-5" },
        { model: "gpt-6.1-sol" },
      ]) {
        const refused = yield* HttpClient.post("/v1/messages", {
          body: HttpBody.jsonUnsafe(body),
        });

        expect(refused.status).toBeGreaterThanOrEqual(400);
        expect(refused.status).toBeLessThan(500);
      }

      expect(yield* Ref.get(seen)).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest))
);
