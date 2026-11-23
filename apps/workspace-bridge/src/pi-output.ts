import { completionOf } from "@mischief/model-bridge/pi-output";
import { CompletionSchema } from "@mischief/model-bridge/protocol";
import { Effect, Option, Schema } from "effect";

import { refusal } from "./protocol.js";

const Event = Schema.Struct({ type: Schema.String });

const Message = Schema.Struct({
  message: Schema.Struct({ role: Schema.String }),
});

const Assistant = Schema.Struct({
  message: Schema.Struct({
    content: Schema.Array(Schema.Unknown),
    errorMessage: Schema.optionalKey(Schema.String),
    role: Schema.Literal("assistant"),
    stopReason: Schema.Literals([
      "stop",
      "length",
      "toolUse",
      "error",
      "aborted",
    ]),
    usage: CompletionSchema.fields.usage,
  }),
});

const CompletionStatus = Schema.Literals([
  400, 401, 403, 404, 413, 429, 500, 502, 503, 504,
]);

export const providerFailure = (
  diagnostic: string,
  provider = "peon/gpt-6.1-sol"
) => {
  const status =
    /(?:\b(?:http|status|(?:api )?error(?: code)?)\s*[:=(]?\s*|^)(?<status>[45]\d{2})\b/iu.exec(
      diagnostic
    )?.groups?.status;

  const parsed = status === undefined ? 502 : Number(status);
  const accepted = Schema.decodeUnknownOption(CompletionStatus)(parsed);

  const safe = diagnostic
    .replaceAll(/\bBearer\s+[^\s"',;]+/giu, "Bearer [redacted]")
    .replaceAll(/\bsk-[a-zA-Z0-9_-]+/gu, "[redacted]")
    .replaceAll(
      /(?<label>(?:api[-_ ]?key|authorization|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu,
      "$<label>[redacted]"
    )
    .replaceAll(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replaceAll(/[\r\n\t]/gu, " ")
    .slice(0, 512);

  return refusal(
    `Workspace ${provider} provider error (status ${status ?? "unknown"}): ${safe || "No provider diagnostic"}. Inspect provider health and credentials, then retry.`,
    Option.getOrElse(accepted, () => 502)
  );
};

export const workspaceCompletionReader = (provider?: string) => {
  let final: typeof Assistant.Type.message | undefined;

  const usage = {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
  };

  const read = Effect.fn("WorkspaceBridge.decodePiEvent")(function* read(
    line: string
  ) {
    if (line.trim() === "") {
      return yield* Effect.void;
    }

    const event = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Event)
    )(line).pipe(
      Effect.mapError(() =>
        refusal(
          "Pi returned invalid JSON events. Check the pinned workspace image and retry.",
          502
        )
      )
    );

    if (event.type !== "message_end") {
      return yield* Effect.void;
    }

    const message = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Message)
    )(line).pipe(
      Effect.mapError(() =>
        refusal(
          "Pi returned an invalid message_end. Check the pinned workspace image and retry.",
          502
        )
      )
    );

    if (message.message.role !== "assistant") {
      return yield* Effect.void;
    }

    const assistant: typeof Assistant.Type = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Assistant)
    )(line).pipe(
      Effect.mapError(() =>
        refusal(
          "Pi returned an unsupported assistant message. Check the pinned workspace image and retry.",
          502
        )
      )
    );

    if (
      assistant.message.stopReason === "error" ||
      assistant.message.stopReason === "aborted"
    ) {
      return yield* providerFailure(
        assistant.message.errorMessage ?? "",
        provider ?? "peon/gpt-6.1-sol"
      );
    }

    for (const key of ["cacheRead", "cacheWrite", "input", "output"] as const) {
      usage[key] += assistant.message.usage[key];
    }

    final = assistant.message;

    return yield* Effect.void;
  });

  const finish = Effect.fn("WorkspaceBridge.finishPi")(function* finish(
    exit: number
  ) {
    if (final === undefined || final.stopReason === "toolUse") {
      return yield* refusal(
        "Pi exited without a final answer after its tool loop. Inspect workspace provider health and retry.",
        502
      );
    }

    return yield* completionOf(
      JSON.stringify({ message: { ...final, usage }, type: "message_end" }),
      exit,
      ""
    );
  });

  return { read, finish };
};

export const workspaceCompletion = Effect.fn("WorkspaceBridge.decodePi")(
  function* workspaceCompletion(
    stdout: string,
    exit: number,
    provider?: string
  ) {
    const reader = workspaceCompletionReader(provider);

    for (const line of stdout.split("\n")) {
      yield* reader.read(line);
    }

    return yield* reader.finish(exit);
  }
);
