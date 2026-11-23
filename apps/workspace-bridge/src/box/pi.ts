import { Clock, Effect, FileSystem, Path } from "effect";

import { refusal } from "../protocol.js";
import { Runner } from "../runner.js";
import { promptEvents } from "./prompt-events.js";
import type { BoxTemplate } from "./protocol.js";

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
  resumeMs: number,
  directory: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });

  const log = yield* fs.open(path.join(directory, "events.jsonl"), {
    flag: "w",
    mode: 0o600,
    noFollow: true,
  });

  const events = promptEvents(log);

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
      consumeStdout: events.consume,
      executable: "docker",
      input: text,
    })
  );

  const { completion, toolCalls } = yield* events.finish(output.exit);

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
}, Effect.scoped);
