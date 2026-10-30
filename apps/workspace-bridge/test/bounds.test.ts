import { expect, it } from "@effect/vitest";
import { Effect, Redacted, Ref, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { Proxy } from "../src/proxy.js";
import { collectBytes } from "../src/runner.js";

it.effect(
  "process and provider error output have real byte bounds, not just declared limits",
  () =>
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
              new Response("x".repeat(64 * 1024 + 1), { status: 503 })
            )
          )
        )
      );

      const failure = yield* Effect.flip(
        Proxy.use(({ forward }) =>
          forward({
            beta: "",
            body: { model: "claude-opus-5-5" },
            version: "2023-06-01",
          })
        ).pipe(
          Effect.provide(
            Proxy.layer({
              key: Redacted.make("host-key"),
              models: ["claude-opus-5-5"],
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
          models: ["claude-opus-5-5"],
          upstream: "https://user:must-not-log@provider.test",
        },
        { models: ["claude-opus-5-5"], upstream: "not a URL" },
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
