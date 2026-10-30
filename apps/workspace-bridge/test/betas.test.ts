import { normalizeContext } from "@earendil-works/pi-ai";
import type { Model, StreamOptions } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Redacted, Ref, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { HttpClient, HttpClientResponse } from "effect/http";
import { vi } from "vitest";

import { Proxy } from "../src/proxy.js";

const betas = [
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
  "server-side-fallback-2026-07-01",
  "mid-conversation-output-config-2026-07-01",
  "thinking-binding-controls-2026-08-01",
  "inline-tools-2026-09-15",
];

const ImageConfig = Schema.Struct({
  providers: Schema.Struct({
    peon: Schema.Struct({
      api: Schema.Literal("anthropic-messages"),
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
        })
      ),
    }),
  }),
});

it.effect.prop(
  "unrecognized beta switches are refused before upstream while Pi's six API-key feature switches pass",
  { suffix: Arbitrary.schema(Schema.String) },
  ({ suffix }) =>
    Effect.gen(function* boundary() {
      const calls = yield* Ref.make(0);

      const client = HttpClient.make((request) =>
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response("")))
        )
      );

      yield* Effect.gen(function* requests() {
        const proxy = yield* Proxy;

        const request = {
          beta: `${betas.join(",")},network-feature-${suffix}`,
          body: { model: "claude-opus-5-5" },
          version: "2023-06-01",
        };

        const failure = yield* Effect.flip(proxy.forward(request));
        expect(failure.status).toBe(403);
        expect(yield* Ref.get(calls)).toBe(0);

        const accepted = yield* Effect.scoped(
          proxy.forward({ ...request, beta: betas.join(", ") })
        );

        expect(accepted.status).toBe(200);
        expect(yield* Ref.get(calls)).toBe(1);
      }).pipe(
        Effect.provide(
          Proxy.layer({
            key: Redacted.make("host-key"),
            models: ["claude-opus-5-5"],
            upstream: "https://provider.test",
          })
        ),
        Effect.provideService(HttpClient.HttpClient, client)
      );
    }).pipe(Effect.scoped)
);

it.effect(
  "the image's API-key configuration sends feature betas but no OAuth betas through the real Pi Anthropic provider",
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

      const model: Model<"anthropic-messages"> = {
        ...entry,
        api: provider.api,
        baseUrl: provider.baseUrl,
        input: [...entry.input],
        provider: "peon",
      };

      const fetch = vi
        .fn<NonNullable<StreamOptions["fetch"]>>()
        .mockResolvedValue(
          new Response(
            '{"type":"error","error":{"type":"invalid_request_error","message":"fake provider boundary"}}',
            { headers: { "content-type": "application/json" }, status: 400 }
          )
        );

      const stream = anthropicMessagesApi().streamSimple(
        model,
        normalizeContext({
          messages: [
            { content: "Review this fixture", role: "user", timestamp: 0 },
          ],
          tools: [
            {
              description: "Read a file",
              name: "read",
              parameters: { properties: {}, type: "object" },
            },
          ],
        }),
        { apiKey: provider.apiKey, fetch, maxRetries: 0, reasoning: "high" }
      );

      yield* Effect.promise(stream.result.bind(stream));
      expect(fetch).toHaveBeenCalledTimes(1);
      const [call] = fetch.mock.calls;

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

      expect(JSON.parse(payload)).not.toHaveProperty("betas");
      expect(sent.get("x-api-key")).toBe("proxy");

      const features = (sent.get("anthropic-beta") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== "");

      expect(features.length).toBeGreaterThan(0);
      expect(features.every((value) => betas.includes(value))).toBe(true);
      expect(features).not.toContain("oauth-2025-04-20");
      expect(features).not.toContain("claude-code-20250219");

      return yield* Effect.void;
    }).pipe(Effect.provide(NodeServices.layer))
);
