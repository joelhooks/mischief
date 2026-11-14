import { normalizeContext } from "@earendil-works/pi-ai";
import type { Model, StreamOptions } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";
import { vi } from "vitest";

import { Proxy, proxyRoutes } from "../src/proxy.js";

const ImageConfig = Schema.Struct({
  providers: Schema.Struct({
    peon: Schema.Struct({
      api: Schema.Literal("openai-responses"),
      apiKey: Schema.Literal("proxy"),
      baseUrl: Schema.String,
      models: Schema.Array(
        Schema.Struct({
          contextWindow: Schema.Int,
          cost: Schema.Struct({
            cacheRead: Schema.Finite,
            cacheWrite: Schema.Finite,
            input: Schema.Finite,
            output: Schema.Finite,
          }),
          id: Schema.String,
          input: Schema.Array(Schema.Literals(["text", "image"])),
          maxTokens: Schema.Int,
          name: Schema.String,
          reasoning: Schema.Boolean,
          thinkingLevelMap: Schema.Struct({
            high: Schema.Literal("high"),
            low: Schema.Literal("low"),
            max: Schema.Literal("max"),
            medium: Schema.Literal("medium"),
            minimal: Schema.Literal("low"),
            off: Schema.Null,
            xhigh: Schema.Literal("xhigh"),
          }),
        })
      ),
    }),
  }),
});

it.effect(
  "the image configuration's real Pi Responses provider reaches the proxy with native function tools and unchanged identity",
  () =>
    Effect.gen(function* imageProvider() {
      const fs = yield* FileSystem.FileSystem;

      const image = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ImageConfig)
      )(yield* fs.readFileString("image/models.json"));

      const provider = image.providers.peon;
      const [entry] = provider.models;

      if (entry === undefined) {
        return yield* Effect.die("the image must define its peon model");
      }

      expect(provider.baseUrl).toBe("http://172.30.211.1:28012/v1");
      expect(entry.contextWindow).toBe(500_000);
      const seen = yield* Ref.make<HttpClientRequest.HttpClientRequest[]>([]);

      const upstream = HttpClient.make((request) =>
        Ref.update(seen, (requests) => [...requests, request]).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                '{"error":{"type":"invalid_request_error","message":"fake provider boundary"}}',
                { headers: { "content-type": "application/json" }, status: 400 }
              )
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
            key: Redacted.make("host-key"),
            models: [entry.id],
            upstream: "http://provider.test",
          }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, upstream)))
        ),
        Layer.build
      );
      const client = yield* HttpClient.HttpClient;
      const endpoint = yield* client.preprocess(HttpClientRequest.get("/v1"));

      const model: Model<"openai-responses"> = {
        ...entry,
        api: provider.api,
        baseUrl: endpoint.url,
        input: [...entry.input],
        provider: "peon",
      };

      const fetch = vi.fn<NonNullable<StreamOptions["fetch"]>>(
        globalThis.fetch
      );

      for (const reasoning of [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ] as const) {
        const stream = openAIResponsesApi().streamSimple(
          model,
          normalizeContext({
            messages: [
              { content: "Review this fixture", role: "user", timestamp: 0 },
            ],
            systemPrompt:
              "You are the Pi fixture. Do not disguise this identity.",
            tools: [
              {
                description: "Read a file",
                name: "read",
                parameters: { properties: {}, type: "object" },
              },
            ],
          }),
          {
            apiKey: provider.apiKey,
            fetch,
            maxRetries: 0,
            reasoning,
            sessionId: "fixture-session",
          }
        );

        const result = yield* Effect.promise(stream.result.bind(stream));
        expect(result.errorMessage).toContain("fake provider boundary");
      }

      const requests = yield* Ref.get(seen);
      expect(requests).toHaveLength(6);
      expect(fetch).toHaveBeenCalledTimes(6);

      for (const [index, forwarded] of requests.entries()) {
        expect(HttpClientRequest.toUrl(forwarded)).toEqual(
          Option.some(new URL("http://provider.test/v1/responses"))
        );
        expect(forwarded.headers.authorization).toBe("Bearer host-key");
        expect(forwarded.headers.session_id).toBe("fixture-session");
        expect(forwarded.headers["user-agent"]).toMatch(/^pi[ /]/u);
        const call = fetch.mock.calls[index];

        if (call === undefined) {
          return yield* Effect.die(
            "the Pi provider did not reach the fake fetch boundary"
          );
        }

        const [url, init] = call;

        const sent = new Headers(
          init?.headers ?? (url instanceof Request ? url.headers : undefined)
        );

        const payload = yield* url instanceof Request
          ? Effect.promise(url.text.bind(url))
          : Schema.decodeUnknownEffect(Schema.String)(init?.body);

        expect(sent.get("authorization")).toBe("Bearer proxy");
        expect(sent.get("user-agent")).toBe(forwarded.headers["user-agent"]);

        const body = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
        )(payload);

        expect(body).toMatchObject({
          model: "gpt-6.1-sol",
          store: false,
          stream: true,
          tools: [{ name: "read", type: "function" }],
        });
        expect(JSON.stringify(body.input)).toContain(
          "Do not disguise this identity"
        );
        expect(body).not.toHaveProperty("background");
        expect(body).not.toHaveProperty("previous_response_id");

        expect(body.reasoning).toMatchObject({
          effort: ["low", "low", "medium", "high", "xhigh", "max"][index],
        });
      }

      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest))
);
