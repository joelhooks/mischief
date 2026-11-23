import type { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Effect, Result, Schema, Stream } from "effect";
import type { FileSystem, PlatformError } from "effect";

import { workspaceCompletionReader } from "../pi-output.js";
import { refusal } from "../protocol.js";
import { OUTPUT_LIMIT } from "../runner.js";

const EVENT_WINDOW = 32 * 1024 * 1024;

const PREFIX_BYTES = 512;

const EVENT_TYPE = /^\s*\{\s*"type"\s*:\s*"(?<type>[^"]+)"/u;

const NON_ASSISTANT_END =
  /^\s*\{\s*"type"\s*:\s*"message_end"\s*,\s*"message"\s*:\s*\{\s*"role"\s*:\s*"(?:user|toolResult|system)"/u;

const ToolEvent = Schema.fromJsonString(
  Schema.Struct({
    toolName: Schema.optionalKey(Schema.String),
    type: Schema.String,
  })
);

const replyTooLarge = () =>
  refusal(
    "Pi's reply exceeds the box result budget. Inspect the session, then ask for a shorter reply with a new requestId.",
    502
  );

const canSkipOversized = (prefix: string) => {
  const type = EVENT_TYPE.exec(prefix)?.groups?.type;

  return (
    (type !== undefined &&
      type !== "message_end" &&
      type !== "tool_execution_start") ||
    NON_ASSISTANT_END.test(prefix)
  );
};

class EventFrames {
  private parts: Uint8Array[] = [];
  private bytes = 0;
  private prefix = "";

  private append(bytes: Uint8Array) {
    if (this.bytes > EVENT_WINDOW) {
      return;
    }

    this.bytes += bytes.byteLength;
    this.parts.push(bytes);

    if (this.bytes > EVENT_WINDOW) {
      const prefix = new Uint8Array(PREFIX_BYTES);
      let offset = 0;

      for (const part of this.parts) {
        const slice = part.subarray(0, PREFIX_BYTES - offset);
        prefix.set(slice, offset);
        offset += slice.byteLength;

        if (offset === PREFIX_BYTES) {
          break;
        }
      }

      this.prefix = new TextDecoder().decode(prefix);
      this.parts = [];
    }
  }

  *push(chunk: Uint8Array) {
    let start = 0;

    while (start < chunk.byteLength) {
      const newline = chunk.indexOf(10, start);

      if (newline === -1) {
        this.append(chunk.subarray(start));

        return;
      }

      this.append(chunk.subarray(start, newline));
      const oversized = this.bytes > EVENT_WINDOW;

      yield {
        line: oversized
          ? this.prefix
          : Buffer.concat(this.parts).toString("utf-8"),
        oversized,
      };

      this.parts = [];
      this.bytes = 0;
      start = newline + 1;
    }
  }
}

export const promptEvents = (file: FileSystem.File) => {
  const frames = new EventFrames();
  const reader = workspaceCompletionReader();
  const toolCalls: string[] = [];
  let storedBytes = 0;
  let toolBytes = 0;
  let failure: BridgeFailure | undefined;

  const write = Effect.fnUntraced(function* write(chunk: Uint8Array) {
    const tail = chunk.subarray(Math.max(0, chunk.byteLength - EVENT_WINDOW));

    if (storedBytes + tail.byteLength > EVENT_WINDOW) {
      yield* file.truncate(0);
      yield* file.seek(0n, "start");
      storedBytes = 0;
    }

    yield* file.writeAll(tail);
    storedBytes += tail.byteLength;
  });

  const read = Effect.fnUntraced(function* read(frame: {
    readonly line: string;
    readonly oversized: boolean;
  }) {
    if (frame.oversized) {
      return yield* canSkipOversized(frame.line)
        ? Effect.void
        : replyTooLarge();
    }

    if (frame.line.trim() === "") {
      return yield* Effect.void;
    }

    yield* reader.read(frame.line);

    const event = yield* Schema.decodeEffect(ToolEvent)(frame.line).pipe(
      Effect.mapError(() =>
        refusal(
          "Pi returned an invalid tool event. Inspect the session before retrying the prompt.",
          502
        )
      )
    );

    if (event.type === "tool_execution_start" && event.toolName !== undefined) {
      toolBytes += Buffer.byteLength(event.toolName) + 1;

      if (toolBytes > OUTPUT_LIMIT) {
        return yield* replyTooLarge();
      }

      toolCalls.push(event.toolName);
    }

    return yield* Effect.void;
  });

  const consumeFrame = Effect.fnUntraced(function* consumeFrame(frame: {
    readonly line: string;
    readonly oversized: boolean;
  }) {
    if (failure === undefined) {
      const outcome = yield* Effect.result(read(frame));

      if (Result.isFailure(outcome)) {
        const { failure: error } = outcome;
        failure = error;
      }
    }
  });

  const consume = (
    stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>
  ) =>
    stdout.pipe(
      Stream.tap(write),
      Stream.concat(Stream.make(Uint8Array.of(10))),
      Stream.flatMap((chunk) => Stream.fromIterable(frames.push(chunk))),
      Stream.runForEach(consumeFrame)
    );

  const finish = Effect.fnUntraced(function* finish(exit: number) {
    if (failure !== undefined) {
      return yield* failure;
    }

    const completion = yield* reader.finish(exit);

    if (Buffer.byteLength(completion.text) + toolBytes > OUTPUT_LIMIT) {
      return yield* replyTooLarge();
    }

    return { completion, toolCalls };
  });

  return { consume, finish };
};
