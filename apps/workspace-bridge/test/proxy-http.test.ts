import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted, Ref, Tracer } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";

import { Proxy, proxyRoutes } from "../src/proxy.js";

it.effect(
  "the HTTP proxy swaps credentials, refuses hosted features and preserves the upstream stream",
  () =>
    Effect.gen(function* seam() {
      const seen = yield* Ref.make<Readonly<Record<string, string>>[]>([]);
      const targets = yield* Ref.make<Option.Option<URL>[]>([]);
      const bytes = "event: response.completed\ndata: {}\n\n";

      const upstream = HttpClient.make((request) =>
        Ref.update(seen, (headers) => [...headers, request.headers]).pipe(
          Effect.andThen(
            Ref.update(targets, (urls) => [
              ...urls,
              HttpClientRequest.toUrl(request),
            ])
          ),
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

      yield* HttpRouter.serve(proxyRoutes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(
          Proxy.layer({
            key: Redacted.make("upstream-only-secret"),
            models: ["gpt-6.1-sol", "claude-opus-5-5"],
            upstream: "http://provider.test",
          }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, upstream)))
        ),
        Layer.build
      );

      const response = yield* HttpClient.post("/v1/responses", {
        body: HttpBody.jsonUnsafe({
          input: [],
          max_output_tokens: 128_000,
          model: "gpt-6.1-sol",
          stream: true,
          tools: [
            { name: "read", parameters: { type: "object" }, type: "function" },
          ],
        }),
        headers: { authorization: "Bearer proxy-placeholder" },
      });

      expect(response.status).toBe(200);
      expect(yield* response.text).toBe(bytes);
      expect(yield* Ref.get(seen)).toEqual([
        expect.objectContaining({
          authorization: "Bearer upstream-only-secret",
        }),
      ]);
      expect(JSON.stringify(yield* Ref.get(seen))).not.toContain(
        "proxy-placeholder"
      );
      expect((yield* Ref.get(seen))[0]).not.toHaveProperty("x-api-key");

      for (const header of [
        "anthropic-beta",
        "openai-beta",
        "x-provider-feature",
        "x-api-key",
      ]) {
        const rejected = yield* HttpClient.post("/v1/responses", {
          body: HttpBody.jsonUnsafe({ model: "gpt-6.1-sol" }),
          headers: { [header]: "enabled" },
        });

        expect(rejected.status).toBe(403);
      }

      for (const target of [
        "/v1/responses?beta=true",
        "/v1/responses?background=true",
        "/v1/responses/",
        "/v1/%72esponses",
        "/v1/messages",
      ]) {
        const rejected = yield* HttpClient.post(target, {
          body: HttpBody.jsonUnsafe({ model: "gpt-6.1-sol" }),
        });

        expect(rejected.status).toBeGreaterThanOrEqual(400);
        expect(rejected.status).toBeLessThan(500);
      }

      for (const extra of [
        { background: true },
        { store: true },
        {
          input: [
            { tools: [{ type: "web_search" }], type: "tool_search_output" },
          ],
        },
        {
          input: [
            {
              role: "developer",
              tools: [{ type: "web_search" }],
              type: "additional_tools",
            },
          ],
        },
        { background: false },
        { previous_response_id: "resp_prior" },
        { tools: [{ type: "web_search" }] },
        { tools: [{ container: { type: "auto" }, type: "code_interpreter" }] },
        { tools: [{ server_url: "https://outside.invalid", type: "mcp" }] },
        { tools: [{ name: "push", parameters: {}, type: "function" }] },
        {
          tools: [
            {
              defer_loading: true,
              name: "read",
              parameters: {},
              type: "function",
            },
          ],
        },
        {
          tools: [
            { format: { type: "grammar" }, name: "bash", type: "custom" },
          ],
        },
        { tool_choice: { type: "web_search" } },
        { max_output_tokens: 128_001 },
        { model: "claude-opus-5-5" },
        { model: "unknown" },
      ]) {
        const rejected = yield* HttpClient.post("/v1/responses", {
          body: HttpBody.jsonUnsafe({ model: "gpt-6.1-sol", ...extra }),
        });

        expect(rejected.status).toBeGreaterThanOrEqual(400);
        expect(rejected.status).toBeLessThan(500);
      }

      expect(yield* Ref.get(seen)).toHaveLength(1);
      expect(yield* Ref.get(targets)).toEqual([
        Option.some(new URL("http://provider.test/v1/responses")),
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeHttpServer.layerTest),
      Effect.provideService(Tracer.DisablePropagation, true)
    )
);
