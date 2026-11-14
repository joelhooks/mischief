import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { FullProxy } from "../src/full-proxy.js";
import { collectBytes } from "../src/runner.js";

it.effect(
  "upstream error bodies cannot echo host credentials and errors above 64 KiB fail bounded",
  () =>
    Effect.gen(function* errors() {
      for (const bytes of ["host-only-secret", "x".repeat(65 * 1024)]) {
        const upstream = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(bytes, { status: 401 })
            )
          )
        );

        yield* Effect.gen(function* forwardFailure() {
          const proxy = yield* FullProxy;

          const call = proxy.forward({
            body: { model: "claude-opus-5-5" },
            headers: {},
            target: "/v1/messages?beta=true",
          });

          if (bytes.length > 64 * 1024) {
            expect((yield* Effect.flip(Effect.scoped(call))).status).toBe(502);
          } else {
            const output = yield* call;
            expect(output.status).toBe(401);

            const text = new TextDecoder().decode(
              yield* collectBytes(output.body, 64 * 1024)
            );

            expect(text).not.toContain("host-only-secret");
            expect(text).toContain("retry the peon prompt");
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(
            FullProxy.layer({
              key: Redacted.make("host-only-secret"),
              models: ["claude-opus-5-5"],
              upstream: "http://192.0.2.4",
            })
          ),
          Effect.provideService(HttpClient.HttpClient, upstream)
        );
      }
    })
);
