import { Effect, Schema } from "effect";

import { BridgeFailure } from "./bridge-failure.js";

export const Effort = Schema.Literals([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const TextPart = Schema.Struct({
  text: Schema.String,
  type: Schema.Literal("input_text"),
});

const InputMessage = Schema.Struct({
  content: Schema.Union([Schema.String, Schema.Array(TextPart)]),
  role: Schema.Literals(["developer", "system", "user"]),
  type: Schema.optionalKey(Schema.Literal("message")),
});

const AssistantMessage = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      annotations: Schema.optionalKey(Schema.Array(Schema.Never)),
      text: Schema.String,
      type: Schema.Literal("output_text"),
    })
  ),
  id: Schema.optionalKey(Schema.String),
  phase: Schema.optionalKey(Schema.Literals(["commentary", "final_answer"])),
  role: Schema.Literal("assistant"),
  status: Schema.optionalKey(Schema.Literal("completed")),
  type: Schema.Literal("message"),
});

export const ResponsesRequestSchema = Schema.Struct({
  include: Schema.optionalKey(
    Schema.Tuple([Schema.Literal("reasoning.encrypted_content")])
  ),
  input: Schema.Array(Schema.Union([InputMessage, AssistantMessage])).check(
    Schema.isMinLength(1)
  ),
  instructions: Schema.optionalKey(Schema.String),
  max_output_tokens: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ maximum: 128_000, minimum: 16 }))
  ),
  model: Schema.Literal("claude-opus-5-5"),
  prompt_cache_key: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(64))
  ),
  reasoning: Schema.Struct({
    effort: Effort,
    summary: Schema.optionalKey(Schema.Literal("auto")),
  }),
  store: Schema.optionalKey(Schema.Literal(false)),
  stream: Schema.Literal(true),
});

export type ResponsesRequest = typeof ResponsesRequestSchema.Type;

export const decodeRequest = (body: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(ResponsesRequestSchema))(
    body,
    {
      onExcessProperty: "error",
    }
  ).pipe(
    Effect.mapError(
      (cause) =>
        new BridgeFailure({
          message: `Invalid Responses request: ${String(cause)}. Send only text messages for claude-opus-5-5 with stream=true and a declared effort (low, medium, high, xhigh, max).`,
          status: 400,
        })
    )
  );

export const CompletionSchema = Schema.Struct({
  stopReason: Schema.Literals(["stop", "length"]),
  text: Schema.String,
  usage: Schema.Struct({
    cacheRead: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cacheWrite: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    input: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    output: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
});

export type Completion = typeof CompletionSchema.Type;

export const promptOf = ({
  input,
  instructions,
}: Pick<ResponsesRequest, "input" | "instructions">) =>
  JSON.stringify({ instructions: instructions ?? "", messages: input });

export const sseOf = ({ stopReason, text, usage }: Completion, id: string) => {
  const item = {
    content: [{ annotations: [], text, type: "output_text" }],
    id: `msg_${id}`,
    role: "assistant",
    status: "completed",
    type: "message",
  };

  const response = {
    id: `resp_${id}`,
    incomplete_details:
      stopReason === "length" ? { reason: "max_output_tokens" } : null,
    output: [item],
    status: stopReason === "length" ? "incomplete" : "completed",
    usage: {
      input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
      input_tokens_details: {
        cache_write_tokens: usage.cacheWrite,
        cached_tokens: usage.cacheRead,
      },
      output_tokens: usage.output,
      total_tokens:
        usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
    },
  };

  return [
    { response: { id: response.id }, type: "response.created" },
    {
      item: { ...item, content: [] },
      output_index: 0,
      type: "response.output_item.added",
    },
    {
      content_index: 0,
      delta: text,
      item_id: item.id,
      output_index: 0,
      type: "response.output_text.delta",
    },
    { item, output_index: 0, type: "response.output_item.done" },
    {
      response,
      type:
        stopReason === "length" ? "response.incomplete" : "response.completed",
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
};
