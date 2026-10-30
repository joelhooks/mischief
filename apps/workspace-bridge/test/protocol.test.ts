import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { workspaceCompletion } from "../src/pi-output.js";
import { decodeRequest } from "../src/protocol.js";
import { completion, request } from "./fixtures.js";

it.effect.prop(
  "workspace output keeps the final answer and accounts for every assistant tool turn",
  {
    tokens: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 }))
    ),
    turns: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 1 }))
    ),
  },
  ({ turns, tokens }) =>
    Effect.gen(function* decoding() {
      const usage = {
        cacheRead: tokens,
        cacheWrite: 0,
        input: tokens,
        output: tokens,
      };

      const prefix = Array.from({ length: turns }, () => [
        {
          message: {
            content: [
              {
                arguments: { path: "proof.ts" },
                id: "tool",
                name: "read",
                type: "toolCall",
              },
            ],
            role: "assistant",
            stopReason: "toolUse",
            usage,
          },
          type: "message_end",
        },
        { type: "tool_execution_start" },
        {
          message: {
            content: [{ text: "evidence", type: "text" }],
            role: "toolResult",
          },
          type: "message_end",
        },
      ]).flat();

      const final = {
        message: {
          content: [{ text: "final finding", type: "text" }],
          role: "assistant",
          stopReason: "stop",
          usage,
        },
        type: "message_end",
      };

      const output = yield* workspaceCompletion(
        [...prefix, final].map((event) => JSON.stringify(event)).join("\n"),
        0
      );

      expect(output.text).toBe("final finding");
      expect(output.usage).toEqual({
        cacheRead: (turns + 1) * tokens,
        cacheWrite: 0,
        input: (turns + 1) * tokens,
        output: (turns + 1) * tokens,
      });
    })
);

it.effect(
  "Responses validation refuses moving refs, uppercase or short sha, unapproved models and unknown fields",
  () =>
    Effect.gen(function* validation() {
      for (const sha of [
        "main",
        "abc123",
        "A".repeat(40),
        "../escape",
        "0".repeat(41),
      ]) {
        const failure = yield* Effect.flip(
          decodeRequest(
            JSON.stringify({
              ...request,
              workspace: { ...request.workspace, sha },
            })
          )
        );

        expect(failure.status).toBe(400);
        expect(failure.message).toContain("40 lowercase hex");
      }

      const model = yield* Effect.flip(
        decodeRequest(JSON.stringify({ ...request, model: "gpt-6.1-sol" }))
      );

      expect(model.status).toBe(400);
      expect(model.message).toContain("Opus");
      expect(
        (yield* Effect.flip(
          decodeRequest(JSON.stringify({ ...request, overrideNetwork: "host" }))
        )).status
      ).toBe(400);
      expect(yield* decodeRequest(JSON.stringify(request))).toEqual(request);
    })
);

it.effect(
  "tool-only exits, malformed streams and failed Pi are never reported as a completed answer",
  () =>
    Effect.gen(function* failedOutputs() {
      for (const stdout of [
        "not JSON",
        JSON.stringify({ type: "agent_end" }),
        JSON.stringify({
          message: {
            content: [],
            role: "assistant",
            stopReason: "toolUse",
            usage: completion.usage,
          },
          type: "message_end",
        }),
      ]) {
        expect(
          (yield* Effect.flip(workspaceCompletion(stdout, 0))).status
        ).toBe(502);
      }

      const output = JSON.stringify({
        message: {
          content: [{ text: "discard", type: "text" }],
          role: "assistant",
          stopReason: "stop",
          usage: completion.usage,
        },
        type: "message_end",
      });

      expect((yield* Effect.flip(workspaceCompletion(output, 1))).status).toBe(
        500
      );
    })
);
