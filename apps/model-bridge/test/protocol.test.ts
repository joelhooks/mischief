import { normalizeContext } from "@earendil-works/pi-ai";
import type { Model, StreamOptions } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { completionOf } from "../src/pi-output.js";
import { CompletionSchema, decodeRequest, sseOf } from "../src/protocol.js";

const model: Model<"openai-responses"> = {
  api: "openai-responses",
  baseUrl: "https://bridge.invalid/v1",
  contextWindow: 1_000_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "claude-opus-5-5",
  input: ["text"],
  maxTokens: 128_000,
  name: "Opus",
  provider: "claude-bridge",
  reasoning: true,
};

const Count = Schema.Int.check(
  Schema.isBetween({ maximum: 100_000, minimum: 0 })
);

const World = Schema.Struct({
  chunks: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
  stopReason: CompletionSchema.fields.stopReason,
  usage: Schema.Struct({
    cacheRead: Count,
    cacheWrite: Count,
    input: Count,
    output: Count,
  }),
});

it.effect.prop(
  "generated Pi JSON events round-trip through pi-ai's own Responses parser with exact text and usage",
  { world: Arbitrary.schema(World) },
  ({ world }) =>
    Effect.gen(function* roundTrip() {
      const text = world.chunks.join("");

      const stdout = `${[
        { type: "session", version: 3 },
        {
          message: { content: "untrusted user text", role: "user" },
          type: "message_end",
        },
        ...world.chunks.map((delta) => ({
          assistantMessageEvent: { delta, type: "text_delta" },
          type: "message_update",
        })),
        {
          message: {
            content: [
              { thinking: "not review output", type: "thinking" },
              { text, type: "text" },
            ],
            role: "assistant",
            stopReason: world.stopReason,
            usage: world.usage,
          },
          type: "message_end",
        },
        { type: "agent_end" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\r\n")}\n`;

      const completion = yield* completionOf(stdout, 0, "");
      const bodies: string[] = [];

      // @effect-diagnostics-next-line asyncFunction:off -- pi-ai invokes the asynchronous fetch boundary with its real request body.
      const fetch: NonNullable<StreamOptions["fetch"]> = async (_url, init) => {
        bodies.push(Schema.decodeUnknownSync(Schema.String)(init?.body));

        return await Promise.resolve(
          new Response(sseOf(completion, "generated"), {
            headers: { "content-type": "text/event-stream" },
          })
        );
      };

      const result = yield* Effect.promise(
        // @effect-diagnostics-next-line asyncFunction:off -- The real pi-ai parser returns a Promise, not an Effect.
        async () =>
          await openAIResponsesApi()
            .streamSimple(
              model,
              normalizeContext({
                messages: [
                  { content: "fixed diff", role: "user", timestamp: 0 },
                ],
                systemPrompt: "Review the supplied diff",
              }),
              { apiKey: "test-key", fetch, maxRetries: 0, reasoning: "medium" }
            )
            .result()
      );

      yield* Effect.promise(
        // @effect-diagnostics-next-line asyncFunction:off -- The parser's continuation builds the actual assistant-message wire shape.
        async () =>
          await openAIResponsesApi()
            .streamSimple(
              model,
              normalizeContext({
                messages: [
                  { content: "fixed diff", role: "user", timestamp: 0 },
                  result,
                  { content: "Check that verdict", role: "user", timestamp: 1 },
                ],
              }),
              { apiKey: "test-key", fetch, maxRetries: 0, reasoning: "medium" }
            )
            .result()
      );

      expect(bodies).toHaveLength(2);

      for (const sent of bodies) {
        const body = yield* decodeRequest(sent);
        expect(body.reasoning.effort).toBe("medium");
      }

      expect(result.stopReason).toBe(world.stopReason);
      expect(
        result.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("")
      ).toBe(text);
      expect(result.usage).toMatchObject({
        ...world.usage,
        totalTokens: Object.values(world.usage).reduce(
          (sum, count) => sum + count,
          0
        ),
      });
    })
);

const Failure = Schema.Struct({
  exit: Schema.Literals([0, 1, 2, 137]),
  status: Schema.Literals([
    400, 401, 403, 404, 413, 422, 429, 500, 502, 503, 504, 529,
  ]),
});

it.effect.prop(
  "Pi failures, including zero exits, retain the HTTP failure class rather than becoming successful text",
  { failure: Arbitrary.schema(Failure) },
  ({ failure }) =>
    Effect.gen(function* classified() {
      const stdout = JSON.stringify({
        message: {
          content: [],
          errorMessage: `HTTP ${failure.status}: provider failure; retry-after: 123`,
          role: "assistant",
          stopReason: "error",
          usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        },
        type: "message_end",
      });

      const error = yield* Effect.flip(completionOf(stdout, failure.exit, ""));
      const clientStatus = failure.status === 422 ? 400 : failure.status;
      const expected = failure.status >= 500 ? 500 : clientStatus;
      expect(error.status).toBe(expected);
      expect(error.retryAfter).toBe(failure.status === 429 ? 123 : undefined);

      if (failure.exit !== 0) {
        const stderrFailure = yield* Effect.flip(
          completionOf(
            "",
            failure.exit,
            `HTTP ${failure.status}: provider failure; retry-after: 123`
          )
        );

        expect(stderrFailure.status).toBe(expected);
        expect(stderrFailure.retryAfter).toBe(
          failure.status === 429 ? 123 : undefined
        );
      }
    })
);

it.effect(
  "request decoding refuses extra keys, tools, images and undeclared thinking before a model starts",
  () =>
    Effect.gen(function* refused() {
      const base = {
        input: [
          { content: [{ text: "diff", type: "input_text" }], role: "user" },
        ],
        model: "claude-opus-5-5",
        reasoning: { effort: "medium" },
        stream: true,
      };

      for (const extra of [
        { tools: [] },
        { reasoning: { effort: "off" } },
        { reasoning: { effort: "minimal" } },
        {
          input: [
            {
              content: [{ image_url: "https://invalid", type: "input_image" }],
              role: "user",
            },
          ],
        },
        { "@code": "not code" },
      ]) {
        const error = yield* Effect.flip(
          decodeRequest(JSON.stringify({ ...base, ...extra }))
        );

        expect(error.status).toBe(400);
      }
    })
);
