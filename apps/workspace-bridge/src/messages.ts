import { Effect, Schema } from "effect";

import { refusal } from "./protocol.js";
import type { ProxyBody } from "./proxy.js";

const MESSAGE_FIELDS = new Set([
  "context_management",
  "max_tokens",
  "messages",
  "metadata",
  "model",
  "output_config",
  "stream",
  "system",
  "thinking",
  "tools",
  "tool_choice",
  "temperature",
]);

export const MESSAGE_HOP_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "proxy-connection",
  "te",
  "upgrade",
]);

const CLAUDE_HEADERS = new Set([
  ...MESSAGE_HOP_HEADERS,
  "accept",
  "accept-encoding",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "anthropic-version",
  "authorization",
  "content-type",
  "user-agent",
  "x-app",
  "x-claude-code-session-id",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
]);

const ClaudeTools = Schema.Array(
  Schema.Union([
    Schema.Struct({
      description: Schema.String,
      input_schema: Schema.Record(Schema.String, Schema.Unknown),
      name: Schema.Literals([
        "mcp__custom-tools__read",
        "mcp__custom-tools__grep",
        "mcp__custom-tools__find",
        "mcp__custom-tools__ls",
        "mcp__custom-tools__bash",
      ]),
    }),
    Schema.Struct({
      defer_loading: Schema.Literal(true),
      description: Schema.Literal(
        "Reserved placeholder that keeps deferred tool loading active; never call this tool."
      ),
      input_schema: Schema.Struct({
        properties: Schema.Record(Schema.String, Schema.Never),
        type: Schema.Literal("object"),
      }),
      name: Schema.Literal("DeferredToolPlaceholder"),
    }),
  ])
);

const OutputConfig = Schema.Struct({
  effort: Schema.Literals(["low", "medium", "high", "xhigh", "max"]),
});

const ToolChoice = Schema.Union([
  Schema.Struct({
    disable_parallel_tool_use: Schema.optionalKey(Schema.Boolean),
    type: Schema.Literals(["auto", "any", "none"]),
  }),
  Schema.Struct({
    disable_parallel_tool_use: Schema.optionalKey(Schema.Boolean),
    name: Schema.Literals([
      "mcp__custom-tools__read",
      "mcp__custom-tools__grep",
      "mcp__custom-tools__find",
      "mcp__custom-tools__ls",
      "mcp__custom-tools__bash",
    ]),
    type: Schema.Literal("tool"),
  }),
]);

const ClaudeOptions = Schema.Struct({
  max_tokens: Schema.Int.check(
    Schema.isBetween({ maximum: 128_000, minimum: 16 })
  ),
  metadata: Schema.optionalKey(Schema.Struct({ user_id: Schema.String })),
  model: Schema.Literal("claude-opus-5-5"),
  stream: Schema.Literal(true),
  temperature: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }))
  ),
  tools: ClaudeTools,
});

export const validateMessages = Effect.fn("PeonProxy.validateMessages")(
  function* validateMessages(
    body: ProxyBody,
    headers: Readonly<Record<string, string>>
  ) {
    if (
      Object.keys(body).some((key) => !MESSAGE_FIELDS.has(key)) ||
      Object.keys(headers).some((key) => !CLAUDE_HEADERS.has(key))
    ) {
      return yield* refusal(
        `Unsupported Claude Messages fields: ${Object.keys(body)
          .filter((key) => !MESSAGE_FIELDS.has(key))
          .join(", ")}; headers: ${Object.keys(headers)
          .filter((key) => !CLAUDE_HEADERS.has(key))
          .join(
            ", "
          )}. Use the pinned claude-bridge provider without extra fields, headers, server tools or connectors and retry.`,
        403
      );
    }

    if (
      headers["anthropic-beta"] !==
        "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,thinking-token-count-2026-05-13,effort-2025-11-24" ||
      headers["anthropic-version"] !== "2023-06-01"
    ) {
      return yield* refusal(
        "Unsupported Claude Messages beta or version. Use the pinned claude-bridge capture's exact beta list and anthropic-version 2023-06-01; remove extra provider features and retry.",
        403
      );
    }

    yield* Schema.decodeUnknownEffect(ClaudeOptions)(body).pipe(
      Effect.mapError(() =>
        refusal(
          "Unsupported Claude Messages model, token ceiling or tools. Send claude-opus-5-5 with stream=true, max_tokens 16..128000, metadata.user_id only, and the five custom-tools MCP tools or DeferredToolPlaceholder. Typed server tools and connectors are not permitted; use the pinned claude-bridge provider and retry.",
          403
        )
      )
    );

    yield* Schema.decodeUnknownEffect(ClaudeTools)(body.tools, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() =>
        refusal(
          "Unsupported Claude Messages tool keys. Only name, description, input_schema and the placeholder's defer_loading=true are permitted. Remove typed server tools and connectors and retry.",
          403
        )
      )
    );

    if (body.tool_choice !== undefined) {
      yield* Schema.decodeUnknownEffect(ToolChoice)(body.tool_choice, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(() =>
          refusal(
            "Unsupported Claude Messages tool_choice. Choose auto, any, none or one of the five named custom-tools MCP tools, with optional disable_parallel_tool_use, and retry.",
            403
          )
        )
      );
    }

    if (body.metadata !== undefined) {
      yield* Schema.decodeUnknownEffect(
        Schema.Struct({ user_id: Schema.String })
      )(body.metadata, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() =>
          refusal(
            "Claude Messages metadata permits user_id only. Remove extra metadata and retry.",
            403
          )
        )
      );
    }

    const output = yield* Schema.decodeUnknownEffect(
      Schema.UndefinedOr(OutputConfig)
    )(body.output_config, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() =>
        refusal(
          "Unsupported Claude Messages output_config. Supply only effort: low, medium, high, xhigh or max and retry.",
          403
        )
      )
    );

    return output?.effort ?? null;
  }
);
