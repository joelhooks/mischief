import { gzipSync } from "node:zlib";

import { expect, it } from "@effect/vitest";
import { Effect, Redacted, Ref, Schema, Stream } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { HttpClient, HttpClientResponse } from "effect/http";

import { Proxy } from "../src/proxy.js";
import { collectBytes } from "../src/runner.js";
import { capturedBody, capturedHeaders } from "./messages-fixture.js";

it.effect.prop(
  "process and provider error output have real byte bounds, not just declared limits",
  { compressed: Arbitrary.schema(Schema.Boolean) },
  ({ compressed }) =>
    Effect.gen(function* bounds() {
      const bytes = new TextEncoder().encode("🐀");
      expect(yield* collectBytes(Stream.make(bytes), 4)).toEqual(bytes);
      expect(
        (yield* Effect.flip(collectBytes(Stream.make(bytes), 3))).status
      ).toBe(502);
      const calls = yield* Ref.make(0);

      const client = HttpClient.make((request) =>
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                compressed
                  ? gzipSync("x".repeat(64 * 1024 + 1))
                  : "x".repeat(64 * 1024 + 1),
                {
                  headers: {
                    "content-encoding": compressed ? "gzip" : "identity",
                  },
                  status: 503,
                }
              )
            )
          )
        )
      );

      const failure = yield* Effect.flip(
        Proxy.use(({ forward }) =>
          forward(
            compressed
              ? {
                  body: capturedBody,
                  headers: capturedHeaders,
                  target: "/v1/messages",
                }
              : {
                  body: { model: "gpt-6.1-sol" },
                }
          )
        ).pipe(
          Effect.provide(
            Proxy.layer({
              key: Redacted.make("host-key"),
              models: ["gpt-6.1-sol", "claude-opus-5-5"],
              upstream: "https://provider.test",
            })
          ),
          Effect.provideService(HttpClient.HttpClient, client)
        )
      );

      expect(failure.status).toBe(503);
      expect(failure.message).toContain("64 KiB");
      expect(yield* Ref.get(calls)).toBe(1);
    }).pipe(Effect.scoped)
);

it.effect(
  "proxy startup refuses credentials in upstream URLs, invalid URLs and model widening without echoing credentials",
  () =>
    Effect.gen(function* configuration() {
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("")))
      );

      for (const config of [
        {
          models: ["gpt-6.1-sol"],
          upstream: "https://user:must-not-log@provider.test",
        },
        { models: ["gpt-6.1-sol"], upstream: "not a URL" },
        {
          models: ["gpt-6.1-sol", "claude-opus-5-5", "unknown"],
          upstream: "https://provider.test",
        },
        {
          models: ["gpt-6.1-sol", "gpt-6.1-sol"],
          upstream: "https://provider.test",
        },
        { models: ["gpt-6.1-sol"], upstream: "https://provider.test" },
      ]) {
        const failure = yield* Effect.flip(
          Proxy.use(() => Effect.void).pipe(
            Effect.provide(
              Proxy.layer({ ...config, key: Redacted.make("host-key") })
            ),
            Effect.provideService(HttpClient.HttpClient, client)
          )
        );

        expect(failure.status).toBe(400);
        expect(failure.message).not.toContain("must-not-log");
      }
    }).pipe(Effect.scoped)
);
