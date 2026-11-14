import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import {
  Clock,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
} from "effect";
import type { PlatformError } from "effect";

import { refusal } from "../protocol.js";
import { checked, Runner } from "../runner.js";
import type { Command } from "../runner.js";
import { nextState } from "./machine.js";
import { promptPi, requireText } from "./pi.js";
import { Metadata, PeonId, Result } from "./protocol.js";
import type { BoxMetadata, Action, Create } from "./protocol.js";
import { receiptKey } from "./receipt.js";

export interface BoxConfig {
  readonly root: string;
  readonly snapshots: string;
  readonly metadata: string;
  readonly image: string;
  readonly mirrors: Readonly<Record<string, string>>;
  readonly gid: number;
}

const Receipt = Schema.Struct({
  error: Schema.optionalKey(BridgeFailure),
  requestId: Schema.String,
  result: Schema.optionalKey(Result),
});

const DockerState = Schema.Struct({
  Pid: Schema.Finite,
  Running: Schema.Boolean,
});

const DNS_WITHOUT_LAN_ROUTER_FORWARDING = [
  "--dns",
  "1.1.1.1",
  "--dns",
  "9.9.9.9",
];

const containerOf = (id: string) => `mischief-peon-box-${id}`;

const hostFailure = (error: PlatformError.PlatformError) =>
  refusal(
    `Box storage operation ${error._tag} failed; continuing could lose the workspace. Inspect host storage and GET /v1/boxes/{id} before retrying.`,
    503
  );

export class Boxes extends Context.Service<
  Boxes,
  {
    readonly create: (
      input: typeof Create.Type
    ) => Effect.Effect<typeof Result.Type, BridgeFailure>;
    readonly act: (
      input: typeof Action.Type
    ) => Effect.Effect<typeof Result.Type, BridgeFailure>;
    readonly inspect: (
      id: string
    ) => Effect.Effect<typeof Result.Type, BridgeFailure>;
  }
>()("@mischief/workspace-bridge/Boxes") {
  static readonly layer = (config: BoxConfig) =>
    Layer.effect(
      Boxes,
      Effect.gen(function* makeBoxes() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* Runner;
        const crypto = yield* Crypto.Crypto;

        const keyOf = (requestId: string) =>
          receiptKey(requestId).pipe(
            Effect.provideService(Crypto.Crypto, crypto)
          );

        const locks = yield* Ref.make(new Set<string>());

        const execute = (command: Command) =>
          checked(command).pipe(Effect.provideService(Runner, runner));

        const docker = (args: readonly string[], input?: string) =>
          input === undefined
            ? execute({ args, executable: "docker" })
            : execute({ args, executable: "docker", input });

        const base = (id: string) => path.join(config.root, id);
        const meta = (id: string) => path.join(config.metadata, id);
        const metadataPath = (id: string) => path.join(meta(id), "box.json");
        const home = (id: string) => path.join(base(id), "home");
        const work = (id: string) => path.join(base(id), "work");

        if (!/^[^\s]+@sha256:[0-9a-f]{64}$/u.test(config.image)) {
          return yield* refusal(
            "A floating box image could change tools after a wake. Set MISCHIEF_PEON_BOX_IMAGE to an immutable @sha256 digest and restart."
          );
        }

        const roots = [config.root, config.snapshots, config.metadata];

        if (
          roots.some((directory, index) =>
            roots.some(
              (other, otherIndex) =>
                index !== otherIndex &&
                (directory === other ||
                  directory.startsWith(`${other.replace(/\/$/u, "")}/`))
            )
          )
        ) {
          return yield* refusal(
            "Box storage roots overlap; hibernating or deleting a peon could erase request metadata or another peon's snapshots. Set MISCHIEF_BOX_ROOT, MISCHIEF_BOX_SNAPSHOTS and MISCHIEF_BOX_METADATA to disjoint host directories, then restart."
          );
        }

        for (const directory of roots) {
          if (
            !path.isAbsolute(directory) ||
            path.normalize(directory) !== directory
          ) {
            return yield* refusal(
              "Box storage paths must be absolute and canonical to avoid deleting another workspace. Correct the box root, snapshot root and metadata root before starting."
            );
          }

          yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });

          if ((yield* fs.realPath(directory)) !== directory) {
            return yield* refusal(
              "Box storage root is a symlink; deletes could escape its partition. Configure real directories and restart."
            );
          }
        }

        const writeJson = Effect.fn("Boxes.writeJson")(function* writeJson(
          file: string,
          value: BoxMetadata | typeof Receipt.Type
        ) {
          yield* fs.writeFileString(`${file}.tmp`, JSON.stringify(value), {
            mode: 0o600,
          });
          yield* fs.rename(`${file}.tmp`, file);
        });

        const load = Effect.fn("Boxes.load")(function* load(id: string) {
          if (!(yield* fs.exists(metadataPath(id)))) {
            return yield* refusal(
              `Box ${id} does not exist. POST /v1/boxes with a pinned workspace before using it.`,
              404
            );
          }

          return yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Metadata)
          )(yield* fs.readFileString(metadataPath(id))).pipe(
            Effect.mapError(() =>
              refusal(
                `Box ${id} metadata is invalid; guessing could destroy its workspace. Repair the host metadata from its receipt before retrying.`,
                503
              )
            )
          );
        });

        const save = (box: BoxMetadata) =>
          writeJson(metadataPath(box.peonId), box);

        const locked = <A, E, R>(
          ids: readonly string[],
          effect: Effect.Effect<A, E, R>
        ) =>
          Effect.scoped(
            Effect.gen(function* lockBoxes() {
              yield* Effect.acquireRelease(
                Effect.gen(function* acquireBoxes() {
                  const accepted = yield* Ref.modify(locks, (held) => [
                    ids.every((id) => !held.has(id)),
                    ids.some((id) => held.has(id))
                      ? held
                      : new Set([...held, ...ids]),
                  ]);

                  if (!accepted) {
                    return yield* refusal(
                      "Box is busy; simultaneous prompts or lifecycle changes could corrupt its session. GET /v1/boxes/{id}, then retry after the active request finishes.",
                      409
                    );
                  }

                  return yield* Effect.void;
                }),
                () =>
                  Ref.update(
                    locks,
                    (held) =>
                      new Set([...held].filter((id) => !ids.includes(id)))
                  )
              );

              return yield* effect;
            })
          );

        const owned = (id: string, initialize = false) =>
          docker([
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--cap-add",
            "CHOWN",
            "--security-opt",
            "no-new-privileges",
            "--user",
            "0",
            "--mount",
            `type=bind,source=${base(id)},target=/box`,
            "--entrypoint",
            "/bin/sh",
            config.image,
            "-c",
            `chown -hR 0:${config.gid} /box && ${initialize ? "cp /opt/peon/models.json /opt/peon/settings.json /box/home/.pi/agent/ && " : ""}chmod -R g+rwX /box && chown -hR 65534:${config.gid} /box`,
          ]).pipe(
            Effect.mapError(() =>
              refusal(
                "Box ownership preparation failed: uid 65534 cannot write its workspace, and without the manager gid the host cannot snapshot or delete it. Check the isolated CHOWN helper and retry.",
                503
              )
            )
          );

        const container = (box: BoxMetadata, start: boolean) =>
          docker([
            "create",
            "--name",
            containerOf(box.peonId),
            "--network",
            "mischief-peon-boxes",
            "--cgroup-parent",
            "mischief-peon-boxes.slice",
            ...DNS_WITHOUT_LAN_ROUTER_FORWARDING,
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            "65534",
            "--cpus",
            String(box.template.limits.cpus),
            "--memory",
            box.template.limits.memory,
            "--pids-limit",
            String(box.template.limits.pids),
            "--restart",
            "no",
            "--workdir",
            "/work",
            "--env",
            "HOME=/home/peon",
            "--env",
            "PI_CODING_AGENT_DIR=/home/peon/.pi/agent",
            "--env",
            "ANTHROPIC_BASE_URL=http://172.30.212.1:28013",
            "--env",
            "ANTHROPIC_AUTH_TOKEN=proxy",
            "--env",
            "OPENAI_BASE_URL=http://172.30.212.1:28013/v1",
            "--mount",
            `type=bind,source=${work(box.peonId)},target=/work`,
            "--mount",
            `type=bind,source=${home(box.peonId)},target=/home/peon`,
            "--entrypoint",
            "/bin/sleep",
            box.image,
            "infinity",
          ]).pipe(
            Effect.andThen(
              start ? docker(["start", containerOf(box.peonId)]) : Effect.void
            )
          );

        const size = Effect.fn("Boxes.size")(function* size(directory: string) {
          if (!(yield* fs.exists(directory))) {
            return 0;
          }

          const text = yield* execute({
            args: ["-sb", directory],
            executable: "du",
          });

          const bytes = Number(text.split(/\s/u)[0]);

          if (!Number.isSafeInteger(bytes) || bytes < 0) {
            return yield* refusal(
              "Host du returned an invalid storage measurement. Check host coreutils and inspect the box again.",
              503
            );
          }

          return bytes;
        });

        const hash = Effect.fn("Boxes.hash")(function* hash(file: string) {
          const output = yield* execute({
            args: [file],
            executable: "sha256sum",
          });

          const digest = output.split(/\s/u)[0] ?? "";

          if (!/^[0-9a-f]{64}$/u.test(digest)) {
            return yield* refusal(
              "Snapshot checksum could not be measured; restoring unchecked bytes could corrupt a session. Check sha256sum and retry.",
              503
            );
          }

          return digest;
        });

        const ready = Effect.fn("Boxes.ready")(function* ready(id: string) {
          const output = yield* docker([
            "inspect",
            "--format",
            "{{json .State}}",
            containerOf(id),
          ]);

          return yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(DockerState)
          )(output.trim()).pipe(
            Effect.mapError(() =>
              refusal(
                "Docker inspect returned invalid box state. Check the container and retry GET /v1/boxes/{id}.",
                503
              )
            )
          );
        });

        const restore = Effect.fn("Boxes.restore")(function* restore(
          box: BoxMetadata,
          target: string
        ) {
          if (box.snapshot === undefined) {
            return yield* refusal(
              "Hibernated box has no snapshot; creating an empty session would lose memory. Restore its metadata before resuming.",
              503
            );
          }

          if ((yield* hash(box.snapshot.path)) !== box.snapshot.sha256) {
            return yield* refusal(
              "Snapshot sha256 differs from its receipt; restoring it would corrupt the workspace. Recover the original snapshot and retry resume.",
              409
            );
          }

          yield* fs.makeDirectory(base(target), {
            mode: 0o770,
            recursive: true,
          });
          yield* execute({
            args: [
              "--no-same-owner",
              "-xf",
              box.snapshot.path,
              "-C",
              base(target),
            ],
            executable: "tar",
          });
          yield* owned(target);

          return yield* Effect.void;
        });

        const resume = Effect.fn("Boxes.resume")(function* resume(
          box: BoxMetadata
        ) {
          if (box.state === "idle") {
            return { box, restored: false };
          }

          const state = yield* nextState(box.state, "RESUME");
          const restored = box.state === "hibernated";

          if (restored) {
            yield* restore(box, box.peonId);
            yield* container(box, false);
          }

          yield* docker(["start", containerOf(box.peonId)]);

          if (!(yield* ready(box.peonId)).Running) {
            return yield* refusal(
              "Docker start did not leave the box running. Inspect its exit state, then retry resume.",
              503
            );
          }

          const updated = { ...box, state };
          yield* save(updated);

          return { box: updated, restored };
        });

        const request = Effect.fn("Boxes.request")(function* request(
          id: string,
          requestId: string,
          operation: Effect.Effect<
            typeof Result.Type,
            BridgeFailure | PlatformError.PlatformError
          >
        ) {
          const requests = path.join(meta(id), "requests");
          yield* fs.makeDirectory(requests, { mode: 0o700, recursive: true });
          const file = path.join(requests, `${yield* keyOf(requestId)}.json`);

          if (yield* fs.exists(file)) {
            const receipt = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Receipt)
            )(yield* fs.readFileString(file)).pipe(
              Effect.mapError(() =>
                refusal(
                  "Box request receipt is corrupt. Recover its host-owned copy before retrying; repeating an unknown prompt could duplicate tools.",
                  503
                )
              )
            );

            if (receipt.requestId !== requestId) {
              return yield* refusal(
                "Request hash matched a different raw requestId; replaying that receipt could return another operation's result. Inspect the host receipt and use a distinct requestId.",
                409
              );
            }

            if (receipt.result !== undefined) {
              return receipt.result;
            }

            if (receipt.error !== undefined) {
              return yield* receipt.error;
            }

            return yield* refusal(
              "This request began but has no committed result; repeating it could duplicate tool effects. GET /v1/boxes/{id} and reconcile the host request receipt before sending a new requestId.",
              409
            );
          }

          yield* writeJson(file, { requestId });

          return yield* operation.pipe(
            Effect.catchTag("PlatformError", (error) =>
              Effect.fail(hostFailure(error))
            ),
            Effect.matchEffect({
              onFailure: (error) =>
                writeJson(file, { error, requestId }).pipe(
                  Effect.andThen(Effect.fail(error))
                ),
              onSuccess: (result) =>
                writeJson(file, { requestId, result }).pipe(Effect.as(result)),
            })
          );
        });

        const create = Effect.fn("Boxes.create")(
          function* create(input: typeof Create.Type) {
            const { peonId: id, template } = input;

            return yield* locked(
              [id],
              request(
                id,
                input.requestId,
                Effect.gen(function* createBox() {
                  if (yield* fs.exists(metadataPath(id))) {
                    return yield* refusal(
                      `Box ${id} already exists; replacing it would discard its session. GET /v1/boxes/${id} or choose a new peonId.`,
                      409
                    );
                  }

                  const mirror = config.mirrors[template.workspace.repo];

                  if (mirror === undefined || !path.isAbsolute(mirror)) {
                    return yield* refusal(
                      "No local walgit mirror is configured for this repo. Add its absolute mirror path to MISCHIEF_BOX_MIRRORS, then retry create.",
                      403
                    );
                  }

                  yield* fs.makeDirectory(base(id), {
                    mode: 0o770,
                    recursive: true,
                  });
                  yield* execute({
                    args: [
                      "clone",
                      "--local",
                      "--no-hardlinks",
                      "--no-checkout",
                      "--",
                      mirror,
                      work(id),
                    ],
                    executable: "git",
                  });
                  yield* execute({
                    args: [
                      "-C",
                      work(id),
                      "checkout",
                      "--detach",
                      template.workspace.sha,
                    ],
                    executable: "git",
                  });

                  const actual = yield* execute({
                    args: ["-C", work(id), "rev-parse", "HEAD"],
                    executable: "git",
                  });

                  if (actual.trim() !== template.workspace.sha) {
                    return yield* refusal(
                      "Git checkout differs from the pinned sha; using it would run the wrong code. Repair the local mirror and retry create.",
                      409
                    );
                  }

                  yield* execute({
                    args: ["-C", work(id), "remote", "remove", "origin"],
                    executable: "git",
                  });
                  const agent = path.join(home(id), ".pi", "agent");
                  yield* fs.makeDirectory(agent, {
                    mode: 0o770,
                    recursive: true,
                  });
                  yield* fs.writeFileString(
                    path.join(home(id), "append-system.md"),
                    [template.system, template.warm?.contract]
                      .filter((value) => value !== undefined)
                      .join("\n\n"),
                    { mode: 0o660 }
                  );

                  for (const doc of template.warm?.docs ?? []) {
                    const target = path.join(home(id), "warm", doc.path);
                    yield* fs.makeDirectory(path.dirname(target), {
                      mode: 0o770,
                      recursive: true,
                    });
                    yield* fs.writeFileString(target, doc.text, {
                      mode: 0o660,
                    });
                  }

                  yield* fs.writeFileString(
                    path.join(agent, "claude-bridge.json"),
                    JSON.stringify({
                      provider: {
                        env: {
                          ANTHROPIC_AUTH_TOKEN: "proxy",
                          ANTHROPIC_BASE_URL: "http://172.30.212.1:28013",
                        },
                        pathToClaudeCodeExecutable: "/usr/local/bin/claude",
                        plan: "max",
                      },
                    }),
                    { mode: 0o660 }
                  );

                  yield* owned(id, true);

                  const box: BoxMetadata = {
                    image: config.image,
                    lastPromptAt: null,
                    peonId: id,
                    state: "idle",
                    template,
                  };

                  yield* container(box, true);
                  yield* save(box);

                  return {
                    image: config.image,
                    peonId: id,
                    state: "idle",
                    workspace: template.workspace,
                  };
                })
              )
            );
          },
          Effect.catchTag("PlatformError", hostFailure)
        );

        const act = Effect.fn("Boxes.act")(
          function* act(input: typeof Action.Type) {
            const id = input.peonId;

            return yield* locked(
              input.action === "clone" && input.newPeonId !== undefined
                ? [id, input.newPeonId]
                : [id],
              request(
                id,
                input.requestId,
                Effect.gen(function* actBox() {
                  let box = yield* load(id);

                  if (input.action === "resume") {
                    const result = yield* resume(box);

                    return {
                      restored: result.restored,
                      state: result.box.state,
                    };
                  }

                  if (input.action === "prompt") {
                    const text = yield* requireText(input.text);

                    const began = yield* Clock.currentTimeMillis;
                    let resumeMs = 0;

                    if (
                      box.state === "suspended" ||
                      box.state === "hibernated"
                    ) {
                      ({ box } = yield* resume(box));
                      resumeMs = (yield* Clock.currentTimeMillis) - began;
                    }

                    box = {
                      ...box,
                      lastPromptAt: yield* Clock.currentTimeMillis,
                      state: yield* nextState(box.state, "PROMPT"),
                    };
                    yield* save(box);

                    const result = yield* promptPi(
                      containerOf(id),
                      box.template,
                      text,
                      began,
                      resumeMs
                    ).pipe(
                      Effect.provideService(Runner, runner),
                      Effect.onError(() =>
                        docker(["stop", containerOf(id)]).pipe(
                          Effect.andThen(save({ ...box, state: "suspended" })),
                          Effect.orDie
                        )
                      )
                    );

                    yield* docker(
                      [
                        "exec",
                        "-i",
                        containerOf(id),
                        "node",
                        "--input-type=module",
                        "-e",
                        "import{mkdir,writeFile}from'node:fs/promises';await mkdir('/home/peon/.box/requests',{recursive:true});const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);await writeFile(process.argv[1],Buffer.concat(chunks))",
                        `/home/peon/.box/requests/${yield* keyOf(input.requestId)}.json`,
                      ],
                      JSON.stringify({ requestId: input.requestId, result })
                    );
                    yield* save({
                      ...box,
                      state: yield* nextState(box.state, "DONE"),
                    });

                    return result;
                  }

                  const state = yield* nextState(
                    box.state,
                    input.action.toUpperCase()
                  );

                  if (input.action === "suspend") {
                    yield* docker(["stop", containerOf(id)]);
                    const stopped = yield* ready(id);

                    if (stopped.Running || stopped.Pid !== 0) {
                      return yield* refusal(
                        "Suspend left a live process; claiming sleep would hide resource use. Inspect Docker state and retry suspend.",
                        503
                      );
                    }

                    yield* save({ ...box, state });

                    return { state };
                  }

                  if (input.action === "hibernate") {
                    if (box.state === "hibernated") {
                      return { snapshot: box.snapshot, state };
                    }

                    yield* docker(["stop", containerOf(id)]);
                    yield* owned(id);
                    const directory = path.join(config.snapshots, id);
                    yield* fs.makeDirectory(directory, {
                      mode: 0o700,
                      recursive: true,
                    });

                    const file = path.join(
                      directory,
                      `${yield* Clock.currentTimeMillis}-${yield* keyOf(input.requestId)}.tar`
                    );

                    yield* execute({
                      args: [
                        "-cf",
                        `${file}.tmp`,
                        "-C",
                        base(id),
                        "work",
                        "home",
                      ],
                      executable: "tar",
                    });
                    yield* fs.rename(`${file}.tmp`, file);

                    const snapshot = {
                      bytes: Number((yield* fs.stat(file)).size),
                      path: file,
                      sha256: yield* hash(file),
                    };

                    yield* save({ ...box, snapshot, state });
                    yield* docker(["rm", containerOf(id)]);
                    yield* fs.remove(base(id), { recursive: true });

                    return { snapshot, state };
                  }

                  if (input.action === "clone") {
                    const target = input.newPeonId;

                    if (target === undefined || target === id) {
                      return yield* refusal(
                        "Clone needs a distinct newPeonId; copying over the source would lose its session. Retry clone with a new id."
                      );
                    }

                    if (
                      (yield* fs.exists(meta(target))) ||
                      (yield* fs.exists(base(target)))
                    ) {
                      return yield* refusal(
                        "Clone target already exists; replacing it would discard another session. Choose a newPeonId and retry clone.",
                        409
                      );
                    }

                    yield* fs.makeDirectory(meta(target), {
                      mode: 0o700,
                      recursive: true,
                    });

                    if (box.state === "hibernated") {
                      yield* restore(box, target);
                    } else {
                      yield* owned(id);
                      yield* fs.makeDirectory(base(target), { mode: 0o770 });
                      yield* execute({
                        args: [
                          "-R",
                          "--preserve=mode,timestamps",
                          "--",
                          `${base(id)}/.`,
                          base(target),
                        ],
                        executable: "cp",
                      });
                      yield* owned(target);
                    }

                    const clone: BoxMetadata = {
                      image: box.image,
                      lastPromptAt: box.lastPromptAt,
                      peonId: target,
                      state: "suspended",
                      template: box.template,
                    };

                    yield* container(clone, false);
                    yield* save(clone);

                    return { peonId: target, state: "suspended" };
                  }

                  if (box.state !== "hibernated" && box.state !== "destroyed") {
                    yield* docker(["rm", "--force", containerOf(id)]);
                  }

                  if (yield* fs.exists(base(id))) {
                    yield* owned(id);
                    yield* fs.remove(base(id), { recursive: true });
                  }

                  yield* save({ ...box, state });

                  return { snapshotKept: box.snapshot !== undefined, state };
                })
              )
            );
          },
          Effect.catchTag("PlatformError", hostFailure)
        );

        const inspect = Effect.fn("Boxes.inspect")(
          function* inspect(id: string) {
            yield* Schema.decodeUnknownEffect(PeonId)(id).pipe(
              Effect.mapError(() =>
                refusal(
                  "Invalid peonId could escape the box directory. Use 1–40 lowercase letters, digits or hyphens, starting with a letter or digit."
                )
              )
            );
            const box = yield* load(id);
            let processes = 0;

            if (!["hibernated", "destroyed"].includes(box.state)) {
              const status = yield* ready(id);

              if (status.Running) {
                const top = yield* docker([
                  "top",
                  containerOf(id),
                  "-eo",
                  "pid",
                ]);

                processes = Math.max(0, top.trim().split("\n").length - 1);
              }
            }

            return {
              bytes: {
                home: yield* size(home(id)),
                snapshot: box.snapshot?.bytes ?? 0,
                work: yield* size(work(id)),
              },
              container: ["hibernated", "destroyed"].includes(box.state)
                ? null
                : containerOf(id),
              lastPromptAt: box.lastPromptAt,
              processes,
              state: box.state,
            };
          },
          Effect.catchTag("PlatformError", hostFailure)
        );

        return Boxes.of({ act, create, inspect });
      }).pipe(Effect.catchTag("PlatformError", hostFailure))
    );
}
