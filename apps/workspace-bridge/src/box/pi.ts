import { Clock, Effect, Schema } from "effect";

import { workspaceCompletion } from "../pi-output.js";
import { refusal } from "../protocol.js";
import { Runner } from "../runner.js";
import type { BoxTemplate } from "./protocol.js";

const ToolEvent = Schema.Struct({
  toolName: Schema.optionalKey(Schema.String),
  type: Schema.String,
});

export const modelOf = (template: BoxTemplate) =>
  template.model === "opus"
    ? "claude-bridge/claude-opus-5-5"
    : "peon/gpt-6.1-sol";

export const requireText = Effect.fn("Box.requireText")(function* requireText(
  text: string | undefined
) {
  if (text === undefined || text.trim() === "") {
    return yield* refusal(
      "Prompt text is empty; no task can run. POST /v1/boxes/{id}/prompt with nonempty text."
    );
  }

  return text;
});

export const promptPi = Effect.fn("Box.promptPi")(function* promptPi(
  container: string,
  template: BoxTemplate,
  text: string,
  began: number,
  resumeMs: number
) {
  const output = yield* Runner.use(({ run }) =>
    run({
      args: [
        "exec",
        "-i",
        "--workdir",
        "/work",
        container,
        "/bin/sh",
        "-c",
        'umask 0007; exec pi "$@"',
        "pi",
        "-p",
        "--mode",
        "json",
        "--session",
        "/home/peon/session.jsonl",
        "--model",
        modelOf(template),
        "--thinking",
        template.thinking,
        "--append-system-prompt",
        "/home/peon/append-system.md",
      ],
      executable: "docker",
      input: text,
    })
  );

  const completion = yield* workspaceCompletion(output.stdout, output.exit);
  const toolCalls: string[] = [];

  for (const line of output.stdout
    .split("\n")
    .filter((value) => value.trim() !== "")) {
    const event = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ToolEvent)
    )(line).pipe(
      Effect.mapError(() =>
        refusal(
          "Pi returned an invalid tool event. Inspect the session before retrying the prompt.",
          502
        )
      )
    );

    if (event.type === "tool_execution_start" && event.toolName !== undefined) {
      toolCalls.push(event.toolName);
    }
  }

  return {
    exit: output.exit,
    model: modelOf(template),
    output: completion.text,
    resumeMs,
    thinking: template.thinking,
    toolCalls,
    usage: {
      ...completion.usage,
      total:
        completion.usage.input +
        completion.usage.output +
        completion.usage.cacheRead +
        completion.usage.cacheWrite,
    },
    wallMs: (yield* Clock.currentTimeMillis) - began,
  };
});
