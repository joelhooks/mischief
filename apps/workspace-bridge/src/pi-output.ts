import { completionOf, failureOf } from "@mischief/model-bridge/pi-output";
import { CompletionSchema } from "@mischief/model-bridge/protocol";
import { Effect, Schema } from "effect";

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

export const workspaceCompletion = Effect.fn("WorkspaceBridge.decodePi")(
  function* workspaceCompletion(stdout: string, exit: number) {
    let final: typeof Assistant.Type.message | undefined;

    const usage = {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
    };

    for (const line of stdout
      .split("\n")
      .filter((entry) => entry.trim() !== "")) {
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
        continue;
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
        continue;
      }

      const assistant = yield* Schema.decodeUnknownEffect(
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
        return yield* failureOf(exit, assistant.message.errorMessage ?? "");
      }

      for (const key of [
        "cacheRead",
        "cacheWrite",
        "input",
        "output",
      ] as const) {
        usage[key] += assistant.message.usage[key];
      }

      final = assistant.message;
    }

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
  }
);
