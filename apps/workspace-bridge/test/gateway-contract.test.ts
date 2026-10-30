import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, it } from "@effect/vitest";
import { Thinker, thinkingLevels } from "@mischief/core";
import { sseOf } from "@mischief/model-bridge/protocol";
import { gatewayThinkerOptions, piThinker } from "@mischief/thinking";
import type { GatewayConfig } from "@mischief/thinking";
import { Effect, Redacted, Schema } from "effect";
import { vi } from "vitest";

import { decodeRequest } from "../src/protocol.js";
import { OUTPUT_TOKEN_CAP, thinkingOf } from "../src/sandbox.js";

const appliedThinking: Readonly<
  Record<(typeof thinkingLevels)[number], ReturnType<typeof thinkingOf>>
> = {
  high: "high",
  low: "low",
  max: "high",
  medium: "medium",
  minimal: "low",
  off: "off",
  xhigh: "high",
};

it.effect(
  "every workspace Opus thinking level sends a gateway body the bridge accepts strictly at its output cap",
  () =>
    Effect.gen(function* contract() {
      const fetch = vi.fn<NonNullable<GatewayConfig["fetch"]>>();

      const endpoint = {
        apiKey: Redacted.make("workspace-key"),
        baseUrl: "https://workspace.invalid/v1/responses",
        fetch,
      };

      const options = gatewayThinkerOptions(
        () => Effect.succeed(new MemoryStorage()),
        {
          apiKey: Redacted.make("gateway-key"),
          baseUrl: "https://gateway.invalid/v1",
          fetch,
          opusBridge: {
            apiKey: Redacted.make("opus-key"),
            baseUrl: "https://opus.invalid/v1",
            fetch,
          },
          workspaceBridge: endpoint,
        }
      );

      const workspace = { repo: "example/project", sha: "a".repeat(40) };
      const tools = ["read", "grep", "find", "ls", "bash"];

      yield* Effect.gen(function* requests() {
        const thinker = yield* Thinker;

        for (const level of thinkingLevels) {
          fetch.mockResolvedValueOnce(
            new Response(
              sseOf(
                {
                  stopReason: "stop",
                  text: "ok",
                  usage: { cacheRead: 0, cacheWrite: 0, input: 3, output: 1 },
                },
                "workspace-contract"
              ),
              { headers: { "content-type": "text/event-stream" } }
            )
          );
          const before = fetch.mock.calls.length;

          const thought = yield* thinker.think({
            agent: {
              model: "claude-opus-5-5",
              thinking: level,
              tools,
              workspace,
            },
            ceiling: "max",
            epoch: 0,
            key: "review",
            prompt: "Read this fixture",
            runId: `workspace-contract-${level}`,
            visit: 1,
          });

          expect(thought.output).toBe("ok");
          expect(fetch.mock.calls).toHaveLength(before + 1);
          const call = fetch.mock.calls.at(-1);

          if (call === undefined) {
            return yield* Effect.die(
              "workspace routing did not reach the fake fetch boundary"
            );
          }

          const [url, init] = call;
          expect(url instanceof Request ? url.url : String(url)).toBe(
            endpoint.baseUrl
          );

          const headers = new Headers(
            init?.headers ?? (url instanceof Request ? url.headers : undefined)
          );

          expect(headers.get("authorization")).toBe("Bearer workspace-key");

          const body = yield* url instanceof Request
            ? Effect.promise(url.text.bind(url))
            : Schema.decodeUnknownEffect(Schema.String)(init?.body);

          const decoded = yield* decodeRequest(body);
          expect(decoded.model).toBe("claude-opus-5-5");
          expect(decoded.workspace).toEqual(workspace);
          expect(decoded.tools).toEqual(tools);
          expect(decoded.max_output_tokens).toBe(OUTPUT_TOKEN_CAP);
          expect(thinkingOf(decoded.reasoning.effort)).toBe(
            appliedThinking[level]
          );

          const original = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
          )(body);

          const unknownField = yield* Effect.flip(
            decodeRequest(
              JSON.stringify({ ...original, unexpected_gateway_field: true })
            )
          );

          expect(unknownField.status).toBe(400);

          const overCap = yield* Effect.flip(
            decodeRequest(
              JSON.stringify({
                ...original,
                max_output_tokens: OUTPUT_TOKEN_CAP + 1,
              })
            )
          );

          expect(overCap.status).toBe(400);
        }

        return yield* Effect.void;
      }).pipe(Effect.provide(piThinker(options)));
    }).pipe(Effect.scoped)
);
