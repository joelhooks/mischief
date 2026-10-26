import { Effect, Option, Schema } from "effect";

import { BridgeFailure } from "./bridge-failure.js";
import { CompletionSchema } from "./protocol.js";
import type { Completion } from "./protocol.js";

const Event = Schema.Struct({ type: Schema.String });

const End = Schema.Struct({
  message: Schema.Struct({
    content: Schema.Array(
      Schema.Union([
        Schema.Struct({ text: Schema.String, type: Schema.Literal("text") }),
        Schema.Struct({
          thinking: Schema.String,
          type: Schema.Literal("thinking"),
        }),
      ])
    ),
    errorMessage: Schema.optionalKey(Schema.String),
    role: Schema.Literal("assistant"),
    stopReason: Schema.Literals(["stop", "length", "error", "aborted"]),
    usage: CompletionSchema.fields.usage,
  }),
  type: Schema.Literal("message_end"),
});

const NonAssistant = Schema.Struct({
  message: Schema.Struct({ role: Schema.Literals(["user", "system"]) }),
  type: Schema.Literal("message_end"),
});

const malformed = () =>
  new BridgeFailure({
    message:
      "Pi returned an incomplete or unsupported JSON event stream. Check the bridge's pinned Pi and claude-bridge versions before resuming the run.",
    status: 502,
  });

export const failureOf = (
  exitCode: number,
  diagnostic: string
): BridgeFailure => {
  const explicit =
    /(?:\b(?:http|status|(?:api )?error(?: code)?)\s*[:=(]?\s*|^)(?<status>[45]\d{2})\b/iu.exec(
      diagnostic
    )?.groups?.status;

  const status = explicit === undefined ? undefined : Number(explicit);

  const limited =
    status === 429 ||
    /rate.?limit|too many requests|out of extra usage/iu.test(diagnostic);

  const retry = /retry[- ]after\s*[:=]?\s*(?<seconds>\d+)/iu.exec(diagnostic)
    ?.groups?.seconds;

  if (limited) {
    return new BridgeFailure({
      message:
        "Claude is rate limited. Hold this step and resume after retry-after.",
      retryAfter:
        retry === undefined ? 60 : Math.min(86_400, Math.max(1, Number(retry))),
      status: 429,
    });
  }

  if (
    status === 401 ||
    status === 403 ||
    /authentication|unauthorized|invalid.*(?:key|token)/iu.test(diagnostic)
  ) {
    return new BridgeFailure({
      message:
        "Claude authentication failed. Fix the dedicated bridge credentials before resubmitting.",
      status: status === 403 ? 403 : 401,
    });
  }

  if (status !== undefined && status < 500) {
    const clientStatus = status === 404 ? 404 : 400;

    return new BridgeFailure({
      message:
        "Claude refused the request. Inspect the plan's text, model and effort before resubmitting.",
      status: status === 413 ? 413 : clientStatus,
    });
  }

  return new BridgeFailure({
    message: `Pi failed (exit ${exitCode}). Check bridge health and provider availability, then resume the run.`,
    status: 500,
  });
};

export const completionOf = Effect.fn("Bridge.completionOf")(
  function* completionOf(stdout: string, exitCode: number, stderr: string) {
    let completion: Completion | undefined;

    for (const line of stdout.split("\n")) {
      if (line.trim() === "") {
        continue;
      }

      const event = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Event)
      )(line).pipe(Effect.mapError(malformed));

      if (event.type !== "message_end") {
        if (
          event.type.startsWith("tool_execution") ||
          event.type === "auto_retry_start" ||
          event.type === "compaction_start"
        ) {
          return yield* malformed();
        }

        continue;
      }

      if (
        Option.isSome(
          Schema.decodeUnknownOption(Schema.fromJsonString(NonAssistant))(line)
        )
      ) {
        continue;
      }

      const { message } = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(End)
      )(line).pipe(Effect.mapError(malformed));

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return yield* failureOf(exitCode, message.errorMessage ?? stderr);
      }

      if (completion !== undefined) {
        return yield* malformed();
      }

      completion = {
        stopReason: message.stopReason,
        text: message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join(""),
        usage: message.usage,
      };
    }

    if (exitCode !== 0) {
      return yield* failureOf(exitCode, stderr);
    }

    return completion ?? (yield* malformed());
  }
);
