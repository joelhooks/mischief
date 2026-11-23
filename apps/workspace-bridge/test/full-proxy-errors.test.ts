import { expect, it } from "@effect/vitest";
import { Console, Effect, Redacted, Ref, Result, Schema } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import { FullProxy } from "../src/full-proxy.js";
import { collectBytes } from "../src/runner.js";

it.effect(
  "full proxy emits one stderr event per upstream failure without logging request data",
  () =>
    Effect.gen(function* upstreamFailure() {
      const output = yield* Console.Console;

      const nonce = yield* SecureRandom.SecureRandom.use(({ uuidV4 }) =>
        uuidV4()
      ).pipe(Effect.provide(SecureRandom.layerWebCrypto));

      const lines: (readonly unknown[])[] = [];

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi
            .spyOn(output, "error")
            .mockImplementation((...values: readonly unknown[]) => {
              lines.push(values);
            })
        ),
        (mock) =>
          Effect.sync(() => {
            mock.mockRestore();
          })
      );

      const hostKey = ["sk", nonce].join("-");
      const callerHeader = `incoming-${nonce}`;
      const privateBody = `payload-${nonce}`;

      for (const failure of ["transport", "status"]) {
        lines.length = 0;

        const requestId = yield* Ref.make<string | undefined>(undefined);

        const upstream = HttpClient.make((request) =>
          Ref.set(requestId, request.headers["x-mischief-request-id"]).pipe(
            Effect.andThen(TestClock.adjust("37 millis")),
            Effect.andThen(
              failure === "transport"
                ? Effect.fail(
                    new HttpClientError.HttpClientError({
                      reason: new HttpClientError.TransportError({
                        request,
                        description: `Bearer ${callerHeader} ${hostKey} ${privateBody}`,
                      }),
                    })
                  )
                : Effect.succeed(
                    HttpClientResponse.fromWeb(
                      request,
                      new Response(privateBody, { status: 503 })
                    )
                  )
            )
          )
        );

        const result = yield* FullProxy.use(({ forward }) =>
          forward({
            body: { model: "gpt-6.1-sol", input: privateBody },
            headers: { "x-extra": callerHeader },
            target: "/v1/responses?beta=true",
          })
        ).pipe(
          Effect.scoped,
          Effect.result,
          Effect.provide(
            FullProxy.layer({
              key: Redacted.make(hostKey),
              models: ["gpt-6.1-sol"],
              upstream: "http://192.0.2.4",
            })
          ),
          Effect.provideService(HttpClient.HttpClient, upstream)
        );

        expect(
          Result.isFailure(result)
            ? result.failure.status
            : result.success.status
        ).toBe(503);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toHaveLength(1);

        const line = lines[0]?.[0];
        const id = yield* Ref.get(requestId);

        expect(id).toMatch(/^[a-f0-9-]{36}$/u);

        const entry = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
        )(line);

        expect(entry).toEqual({
          event: "peon_upstream_transport_error",
          model: "gpt-6.1-sol",
          route: "/v1/responses",
          durationMs: 37,
          requestId: id,
          ...(failure === "transport"
            ? { errorClass: "TransportError" }
            : { upstreamStatus: 503 }),
        });
      }
    })
);

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
