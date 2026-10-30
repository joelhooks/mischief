import type { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { promptOf } from "@mischief/model-bridge/protocol";
import type { Completion } from "@mischief/model-bridge/protocol";
import {
  Clock,
  Context,
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  Option,
  Ref,
  Schedule,
  Schema,
} from "effect";

import { Exports, safePath } from "./exports.js";
import { workspaceCompletion } from "./pi-output.js";
import { refusal } from "./protocol.js";
import type { WorkspaceRequest } from "./protocol.js";
import { Runner } from "./runner.js";

export const SHELL_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

export const Image = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[0-9a-f]{64}$/u)
);

export const ContainerName = Schema.String.check(
  Schema.isPattern(
    /^mischief-peon-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
  )
);

export const OUTPUT_TOKEN_CAP = 128_000;

export const thinkingOf = (effort: WorkspaceRequest["reasoning"]["effort"]) =>
  effort === "xhigh" || effort === "max" ? "high" : effort;

export const dockerArguments = (
  image: string,
  exportPath: string,
  name: string,
  thinking: WorkspaceRequest["reasoning"]["effort"]
) => [
  "run",
  "--rm",
  "--interactive",
  "--name",
  name,
  "--label",
  "mischief.peon=1",
  "--network",
  "mischief-peons",
  "--cgroup-parent",
  "mischief-peons.slice",
  "--read-only",
  "--tmpfs",
  "/tmp:size=256m",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--user",
  "65534:65534",
  "--memory",
  "2g",
  "--memory-swap",
  "2g",
  "--cpus",
  "1",
  "--pids-limit",
  "256",
  "-v",
  `${exportPath}:/work:ro`,
  image,
  "pi",
  "-p",
  "--no-session",
  "--tools",
  "read,grep,find,ls,bash",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--model",
  "peon/claude-opus-5-5",
  "--thinking",
  thinking,
  "--system-prompt",
  "You are a read-only code review peon. The input is a JSON envelope with instructions and text messages. Follow those instructions. Inspect /work with read, grep, find, ls and bash. Quote file paths and reference evidence. Do not attempt writes or network access.",
  "--mode",
  "json",
];

const Event = Schema.Struct({ type: Schema.String });

const ReceiptState = Schema.Struct({
  exit: Schema.NullOr(Schema.Int),
  toolCalls: Schema.Int,
});

const ModelReply = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.Struct({
      role: Schema.Literal("assistant"),
      stopReason: Schema.Literals(["stop", "length", "toolUse"]),
    }),
    type: Schema.Literal("message_end"),
  })
);

const toolCalls = (stdout: string) =>
  stdout.split("\n").filter((line) => {
    const event = Schema.decodeUnknownOption(Schema.fromJsonString(Event))(
      line
    );

    return Option.isSome(event) && event.value.type === "tool_execution_start";
  }).length;

export class Sandbox extends Context.Service<
  Sandbox,
  {
    readonly run: (
      request: WorkspaceRequest
    ) => Effect.Effect<Completion, BridgeFailure>;
    readonly sweep: Effect.Effect<void, BridgeFailure>;
  }
>()("@mischief/workspace-bridge/Sandbox") {
  static readonly layer = (image: string) =>
    Layer.effect(
      Sandbox,
      Effect.gen(function* makeSandbox() {
        const pinnedImage = yield* Schema.decodeUnknownEffect(Image)(
          image
        ).pipe(
          Effect.mapError(() =>
            refusal(
              "MISCHIEF_WORKSPACE_IMAGE must be an image reference pinned with @sha256 and 64 lowercase hex characters. Build and approve that image digest before starting the bridge."
            )
          )
        );

        const runner = yield* Runner;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const exports = yield* Exports;
        const active = yield* Ref.make(new Set<string>());
        const primed = yield* Deferred.make<boolean>();
        const leaderChosen = yield* Ref.make(false);

        const remove = (name: string) =>
          runner
            .run({ args: ["rm", "--force", name], executable: "docker" })
            .pipe(
              Effect.flatMap((output) =>
                output.exit === 0
                  ? Effect.void
                  : runner
                      .run({
                        args: ["ps", "-aq", "--filter", `name=^${name}$`],
                        executable: "docker",
                      })
                      .pipe(
                        Effect.flatMap((remaining) =>
                          remaining.exit === 0 && remaining.stdout.trim() === ""
                            ? Effect.void
                            : Effect.fail(
                                refusal(
                                  "Docker teardown failed. Inspect the labeled peon containers on the host before retrying.",
                                  503
                                )
                              )
                        )
                      )
              )
            );

        const sweep = Effect.gen(function* sweepOrphans() {
          const listed = yield* runner.run({
            args: ["ps", "-aq", "--filter", "label=mischief.peon=1"],
            executable: "docker",
          });

          if (listed.exit !== 0) {
            return yield* refusal(
              "Docker orphan sweep failed. Check Docker before starting the workspace bridge.",
              503
            );
          }

          for (const id of listed.stdout.trim().split("\n").filter(Boolean)) {
            if (!/^[0-9a-f]{12,64}$/u.test(id)) {
              return yield* refusal(
                "Docker returned an invalid container id during orphan sweep. Inspect Docker before retrying.",
                503
              );
            }

            const inspected = yield* runner.run({
              args: ["inspect", "--format", "{{.Name}}", id],
              executable: "docker",
            });

            const name = inspected.stdout.trim().replace(/^\//u, "");

            if (
              inspected.exit === 0 &&
              Schema.is(ContainerName)(name) &&
              !(yield* Ref.get(active)).has(name)
            ) {
              yield* remove(name);
            }
          }

          return yield* Effect.void;
        });

        yield* sweep;
        yield* sweep.pipe(
          Effect.andThen(exports.gc),
          Effect.catch((error) => Effect.logError(error.message)),
          Effect.repeat(Schedule.spaced("1 hour")),
          Effect.forkScoped
        );

        const run = Effect.fn("WorkspaceSandbox.run")(function* run(
          request: WorkspaceRequest
        ) {
          if (
            request.tools.length !== SHELL_TOOLS.length ||
            new Set(request.tools).size !== SHELL_TOOLS.length ||
            SHELL_TOOLS.some((tool) => !request.tools.includes(tool))
          ) {
            return yield* refusal(
              "Workspace v1 requires exactly read, grep, find, ls, bash. Authorize all five tools in agent.tools and envelope.tools, or remove the workspace."
            );
          }

          if (
            (request.max_output_tokens ?? OUTPUT_TOKEN_CAP) < OUTPUT_TOKEN_CAP
          ) {
            return yield* refusal(
              `Workspace v1 uses a fixed ${OUTPUT_TOKEN_CAP} output-token ceiling. Request max_output_tokens=${OUTPUT_TOKEN_CAP} or omit it; smaller caps require a future image profile.`
            );
          }

          const checkout = yield* exports.checkout(request.workspace);
          yield* safePath(checkout.path).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.mapError(() =>
              refusal(
                "The export path contains a symlink or is missing. Rebuild the pinned export without symlinks before retrying.",
                400
              )
            )
          );
          const input = promptOf(request);

          if (new TextEncoder().encode(input).byteLength > 8 * 1024 * 1024) {
            return yield* refusal(
              "The workspace prompt exceeds 8 MiB. Reduce the input before retrying.",
              413
            );
          }

          yield* (yield* Ref.getAndSet(leaderChosen, true))
            ? Deferred.await(primed)
            : Effect.addFinalizer(() => Deferred.succeed(primed, true));

          const name = yield* Schema.decodeUnknownEffect(ContainerName)(
            `mischief-peon-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`
          ).pipe(Effect.orDie);

          const start = yield* Clock.currentTimeMillis;

          const receipt = yield* Ref.make<typeof ReceiptState.Type>({
            exit: null,
            toolCalls: 0,
          });

          yield* Effect.acquireRelease(
            Ref.update(active, (names) => new Set(names).add(name)),
            () =>
              remove(name).pipe(
                Effect.catch((error) => Effect.logError(error.message)),
                Effect.andThen(
                  Ref.update(
                    active,
                    (names) =>
                      new Set([...names].filter((entry) => entry !== name))
                  )
                ),
                Effect.andThen(
                  Effect.gen(function* recordReceipt() {
                    yield* Effect.logInfo({
                      ...(yield* Ref.get(receipt)),
                      appliedThinking: thinkingOf(request.reasoning.effort),
                      container: name,
                      event: "workspace_receipt",
                      exportDigest: checkout.digest,
                      outputTokenCap: OUTPUT_TOKEN_CAP,
                      repo: request.workspace.repo,
                      requestedThinking: request.reasoning.effort,
                      sha: request.workspace.sha,
                      wallMs: (yield* Clock.currentTimeMillis) - start,
                    });
                  })
                )
              )
          );

          const decoder = new TextDecoder();
          let pendingLine = "";

          const onStdout = (chunk: Uint8Array) =>
            Effect.gen(function* observeModelReply() {
              const lines = (
                pendingLine + decoder.decode(chunk, { stream: true })
              ).split("\n");

              pendingLine = lines.pop() ?? "";
              const observed = toolCalls(lines.join("\n"));
              yield* Ref.update(receipt, (state) => ({
                ...state,
                toolCalls: state.toolCalls + observed,
              }));

              if (
                lines.some((line) =>
                  Option.isSome(Schema.decodeUnknownOption(ModelReply)(line))
                )
              ) {
                yield* Deferred.succeed(primed, true);
              }
            });

          const output = yield* runner.run({
            args: dockerArguments(
              pinnedImage,
              checkout.path,
              name,
              thinkingOf(request.reasoning.effort)
            ),
            executable: "docker",
            input,
            onStdout,
          });

          yield* Ref.set(receipt, {
            exit: output.exit,
            toolCalls: toolCalls(output.stdout),
          });

          return yield* workspaceCompletion(output.stdout, output.exit);
        }, Effect.scoped);

        return Sandbox.of({ run, sweep });
      })
    );
}
