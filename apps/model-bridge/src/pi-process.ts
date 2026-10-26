import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { BridgeFailure } from "./bridge-failure.js";
import { completionOf } from "./pi-output.js";
import { promptOf } from "./protocol.js";
import type { Completion, ResponsesRequest } from "./protocol.js";

export const CALL_TIMEOUT_MS = 1_380_000;

export const OUTPUT_LIMIT = 16 * 1024 * 1024;

export interface PiConfig {
  readonly claude: string;
  readonly cliproxyKey: Redacted.Redacted;
  readonly cliproxyUrl: string;
  readonly extension: string;
  readonly pi: string;
}

export const childEnvironment = (agentDir: string, maxTokens: number) => ({
  CLAUDE_BRIDGE_DEBUG: "0",
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
  HOME: process.env.HOME,
  LANG: "C.UTF-8",
  PATH: process.env.PATH,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  RATKING_NAME: "off",
});

export const piArguments = (
  extension: string,
  thinking: ResponsesRequest["reasoning"]["effort"]
) => [
  "--no-session",
  "-p",
  "--no-tools",
  "--no-extensions",
  "-e",
  extension,
  "--no-skills",
  "--no-prompt-templates",
  "--model",
  "claude-bridge/claude-opus-5-5",
  "--thinking",
  thinking,
  "--mode",
  "json",
  "--system-prompt",
  "You are a review peon. The input is a JSON envelope with instructions and text messages. Follow its instructions and review only the supplied text. You have no tools.",
];

const collect = <E>(stream: Stream.Stream<Uint8Array, E>, limit: number) =>
  Effect.gen(function* boundedOutput() {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    yield* Stream.runForEach(stream, (chunk) => {
      bytes += chunk.byteLength;

      if (bytes > limit) {
        return Effect.fail(
          new BridgeFailure({
            message:
              "Pi output exceeded the bridge's byte limit. Reduce this review's input and output cap before resubmitting.",
            status: 502,
          })
        );
      }

      chunks.push(chunk);

      return Effect.void;
    });
    const joined = new Uint8Array(bytes);
    let offset = 0;

    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return new TextDecoder().decode(joined);
  });

export class PiProcess extends Context.Service<
  PiProcess,
  {
    readonly run: (
      request: ResponsesRequest
    ) => Effect.Effect<Completion, BridgeFailure>;
  }
>()("@mischief/model-bridge/PiProcess") {
  static readonly layer = (config: PiConfig) =>
    Layer.effect(
      PiProcess,
      Effect.gen(function* makePiProcess() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        const agentDir = yield* fs.makeTempDirectoryScoped({
          prefix: "mischief-opus-agent-",
        });

        yield* fs.chmod(agentDir, 0o700);
        yield* fs.writeFileString(
          path.join(agentDir, "settings.json"),
          JSON.stringify({
            cacheWarming: "off",
            compaction: { enabled: false },
            retry: {
              enabled: false,
              maxRetries: 0,
              provider: { maxRetries: 0 },
            },
          }),
          { mode: 0o600 }
        );
        yield* fs.writeFileString(
          path.join(agentDir, "claude-bridge.json"),
          JSON.stringify({
            provider: {
              env: {
                ANTHROPIC_AUTH_TOKEN: Redacted.value(config.cliproxyKey),
                ANTHROPIC_BASE_URL: config.cliproxyUrl,
              },
              pathToClaudeCodeExecutable: config.claude,
              plan: "max",
            },
          }),
          { mode: 0o600 }
        );

        const run = Effect.fn("PiProcess.run")(
          function* run(request: ResponsesRequest) {
            const cwd = yield* fs.makeTempDirectoryScoped({
              prefix: "mischief-opus-call-",
            });

            const child = yield* spawner.spawn(
              ChildProcess.make(
                config.pi,
                piArguments(config.extension, request.reasoning.effort),
                {
                  cwd,
                  env: childEnvironment(
                    agentDir,
                    request.max_output_tokens ?? 128_000
                  ),
                  extendEnv: false,
                  forceKillAfter: "2 seconds",
                  stdin: Stream.make(
                    new TextEncoder().encode(promptOf(request))
                  ),
                }
              )
            );

            const [stdout, stderr, exit] = yield* Effect.all(
              [
                collect(child.stdout, OUTPUT_LIMIT),
                collect(child.stderr, 64 * 1024),
                child.exitCode,
              ],
              { concurrency: "unbounded" }
            );

            yield* Effect.logInfo({
              event: "pi_exit",
              exitCode: Number(exit),
              stderrBytes: new TextEncoder().encode(stderr).byteLength,
              stdoutBytes: new TextEncoder().encode(stdout).byteLength,
            });

            return yield* completionOf(stdout, Number(exit), stderr);
          },
          Effect.scoped,
          Effect.catchTag("PlatformError", () =>
            Effect.fail(
              new BridgeFailure({
                message:
                  "The bridge could not start or collect Pi. Check MISCHIEF_OPUS_PI_BIN, MISCHIEF_OPUS_CLAUDE_BIN and MISCHIEF_OPUS_EXTENSION, then resume the run.",
                status: 500,
              })
            )
          )
        );

        return PiProcess.of({ run });
      })
    );
}
