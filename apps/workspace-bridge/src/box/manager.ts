import { hostname } from "node:os";

import { PeonState } from "@mischief/core";
import type { BoxTailResult, PeonTailQuery } from "@mischief/core";
import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import {
  Cause,
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import type { Duration, PlatformError } from "effect";
import * as Digest from "effect/crypto/Digest";

import { refusal } from "../protocol.js";
import { checked, Runner } from "../runner.js";
import type { Command, ProcessOutput } from "../runner.js";
import type { ArchiveFailure } from "./archive-failure.js";
import { agentDirs, collectArchive } from "./archive-source.js";
import {
  ArchivePort,
  ReadBackResult,
  archiveId,
  linkManifest,
} from "./archive.js";
import type { OpenArchive } from "./archive.js";
import { BoxCapacity } from "./box-capacity.js";
import { browserArgs } from "./browser.js";
import {
  BoxImages,
  DEFAULT_BROWSER_MAX_LIVE,
  floatingImageRefusal,
} from "./config.js";
import type { CustodyMissing } from "./custody-missing.js";
import { CustodyIncomplete } from "./custody-refusal.js";
import { DestroyInProgress } from "./destroy-in-progress.js";
import { nextState } from "./machine.js";
import { promptPi, requireText } from "./pi.js";
import { PromptFailed } from "./prompt-failed.js";
import { Metadata, PeonId, Result, Tombstone } from "./protocol.js";
import type { BoxMetadata, Action, Create } from "./protocol.js";
import { ReceiptMismatch } from "./receipt-mismatch.js";
import { receiptKey } from "./receipt.js";
import { ReplicaMismatch } from "./replica-mismatch.js";
import { ReplicaPending } from "./replica-pending.js";
import { readSessionTail } from "./session-tail.js";
import { unlanded, verifyWorkspace } from "./workspace-proof.js";
import type { WorkspaceUnlanded } from "./workspace-unlanded.js";

export interface BoxConfig {
  readonly root: string;
  readonly snapshots: string;
  readonly metadata: string;
  readonly mount: string;
  readonly image: string;
  readonly browserImage?: string | undefined;
  readonly browserBuildRoot?: string;
  readonly browserMaxLive?: number;
  readonly mirrors: Readonly<Record<string, string>>;
  readonly gid: number;
  readonly parkArchiveTimeout?: Duration.Input;
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

const BROWSER_LABEL = "sh.mischief.box.image-key=browser";

const containerOf = (id: string) => `mischief-peon-box-${id}`;

const diagnosticOf = (stderr: string | undefined) =>
  (stderr ?? "No helper stderr")
    .replaceAll(/\bBearer\s+[^\s"',;]+/giu, "Bearer [redacted]")
    .replaceAll(/\bsk-[a-zA-Z0-9_-]+/gu, "[redacted]")
    .replaceAll(
      /(?<label>(?:api[-_ ]?key|authorization|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu,
      "$<label>[redacted]"
    )
    .replaceAll(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replaceAll(/\p{Cc}/gu, " ")
    .slice(0, 512);

const hostFailure = (error: PlatformError.PlatformError) =>
  refusal(
    `Box storage operation ${error._tag} failed; continuing could lose the workspace. Inspect host storage and GET /v1/boxes/{id} before retrying.`,
    503
  );

const archiveRefusal = (failure: ArchiveFailure) =>
  refusal(failure.message, 409);

const mismatch = (id: string, reason: string) =>
  new ReceiptMismatch({
    reason,
    message: `${reason} Check custody, then POST /v1/boxes/${id}/export before retrying DELETE.`,
    status: 409,
  });

const needsExport = (id: string) =>
  mismatch(
    id,
    `Box ${id} has no matching verified receipt in both protected archives; destroy would lose its raw history.`
  );

type DestroyMarker = NonNullable<BoxMetadata["destroying"]>;

type ArchiveSource = Effect.Success<ReturnType<typeof collectArchive>>;

const latestImmutableArchive = (box: BoxMetadata) =>
  box.archive?.peon === box.peonId &&
  box.archive.box === containerOf(box.peonId)
    ? box.archive
    : undefined;

const currentArchive = (
  box: BoxMetadata,
  { files, manifest }: ArchiveSource
) => {
  const latest = latestImmutableArchive(box);

  return latest?.fingerprint === files.fingerprint &&
    JSON.stringify(latest.skippedEntries ?? []) ===
      JSON.stringify(manifest.skipped)
    ? latest
    : undefined;
};

const supersededWork = (snapshotBytes: number | undefined) =>
  snapshotBytes === undefined
    ? {}
    : { snapshotWorkSuperseded: true, snapshotBytes };

type SnapshotRoot = Effect.Effect<
  string,
  BridgeFailure | PlatformError.PlatformError
>;

const inProgress = (marker: DestroyMarker) =>
  new DestroyInProgress({
    requestId: marker.requestId,
    disposition: marker.disposition,
    retained: marker.retainSnapshot,
    message:
      "Box is destroying. Retry DELETE with the recorded disposition and retention setting.",
    status: 409,
  });

const dispositionOf = (input: typeof Action.Type) => {
  if (input.discardWorkspace !== true) {
    return input.landedHead;
  }

  return input.landedHead === undefined ? "discardWorkspace" : undefined;
};

const archiveError = (failure: ArchiveFailure | CustodyMissing) =>
  Predicate.isTagged(failure, "CustodyMissing")
    ? failure
    : archiveRefusal(failure);

export class Boxes extends Context.Service<
  Boxes,
  {
    readonly create: (
      input: typeof Create.Type
    ) => Effect.Effect<typeof Result.Type, BridgeFailure | BoxCapacity>;
    readonly act: (
      input: typeof Action.Type
    ) => Effect.Effect<
      typeof Result.Type,
      | BridgeFailure
      | BoxCapacity
      | WorkspaceUnlanded
      | CustodyMissing
      | CustodyIncomplete
      | DestroyInProgress
      | PromptFailed
      | ReceiptMismatch
      | ReplicaMismatch
      | ReplicaPending
    >;
    readonly inspect: (
      id: string
    ) => Effect.Effect<typeof Result.Type, BridgeFailure>;
    readonly tail: (
      id: string,
      query: typeof PeonTailQuery.Type
    ) => Effect.Effect<typeof BoxTailResult.Type, BridgeFailure>;
  }
>()("@mischief/workspace-bridge/Boxes") {
  static readonly layer = (config: BoxConfig) =>
    Layer.effect(
      Boxes,
      Effect.gen(function* makeBoxes() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* Runner;
        const crypto = yield* Digest.Digest;
        const archive = yield* ArchivePort;

        const keyOf = (requestId: string) =>
          receiptKey(requestId).pipe(
            Effect.provideService(Digest.Digest, crypto)
          );

        const locks = yield* Ref.make(new Set<string>());

        const execute = (command: Command) =>
          checked(command).pipe(Effect.provideService(Runner, runner));

        const docker = (args: readonly string[], input?: string) =>
          input === undefined
            ? execute({ args, executable: "docker" })
            : execute({ args, executable: "docker", input });

        const admission = yield* Semaphore.make(1);
        const maxLive = config.browserMaxLive ?? DEFAULT_BROWSER_MAX_LIVE;

        const withBrowserCapacity =
          (
            template: BoxMetadata["template"],
            id: string,
            state: typeof BoxCapacity.fields.state.Type
          ) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            template.imageKey === "browser"
              ? admission.withPermit(
                  Effect.gen(function* admitBrowser() {
                    const output = yield* docker([
                      "ps",
                      "--filter",
                      `label=${BROWSER_LABEL}`,
                      "--format",
                      "{{.Names}}",
                    ]);

                    const live = output
                      .split("\n")
                      .map((name) => name.trim())
                      .filter(Boolean);

                    if (
                      !live.includes(containerOf(id)) &&
                      live.length >= maxLive
                    ) {
                      return yield* new BoxCapacity({
                        message: `This host already has ${maxLive} running browser boxes. Suspend or destroy one, then retry spawnPeon, resumePeon or promptPeon.`,
                        state,
                        status: 429,
                      });
                    }

                    return yield* effect;
                  })
                )
              : effect;

        const base = (id: string) => path.join(config.root, id);
        const meta = (id: string) => path.join(config.metadata, id);
        const metadataPath = (id: string) => path.join(meta(id), "box.json");
        const home = (id: string) => path.join(base(id), "home");
        const work = (id: string) => path.join(base(id), "work");

        const configuredImages =
          config.browserImage === undefined
            ? { full: config.image }
            : { full: config.image, browser: config.browserImage };

        const images = yield* Schema.decodeEffect(BoxImages)(
          configuredImages
        ).pipe(Effect.mapError(floatingImageRefusal));

        const roots = [config.root, config.snapshots, config.metadata];

        if (
          !path.isAbsolute(config.mount) ||
          config.mount === "/" ||
          path.normalize(config.mount) !== config.mount ||
          roots.some((directory) => !directory.startsWith(`${config.mount}/`))
        ) {
          return yield* refusal(
            "Box storage roots must sit beneath MISCHIEF_BOX_MOUNT, an absolute canonical dedicated volume path. Writes outside the capped volume could fill the shared disk and stop other services. Set MISCHIEF_BOX_MOUNT and all three storage roots to that volume, then restart."
          );
        }

        if ((yield* fs.realPath(config.mount)) !== config.mount) {
          return yield* refusal(
            "MISCHIEF_BOX_MOUNT resolves through a symlink; box writes could escape the capped volume and fill the shared disk. Set it to the real mounted volume path, then restart."
          );
        }

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

          let ancestor = directory;

          while (!(yield* fs.exists(ancestor))) {
            ancestor = path.dirname(ancestor);
          }

          if ((yield* fs.realPath(ancestor)) !== ancestor) {
            return yield* refusal(
              "Box storage root or ancestor is a symlink; writes could escape the capped volume and fill the shared disk. Configure real directories beneath MISCHIEF_BOX_MOUNT, then restart."
            );
          }
        }

        for (const directory of roots) {
          yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });

          if ((yield* fs.realPath(directory)) !== directory) {
            return yield* refusal(
              "Box storage root is a symlink; deletes could escape its partition. Configure real directories and restart."
            );
          }
        }

        const sweepSnapshotReads = Effect.fn("Boxes.sweepSnapshotReads")(
          function* sweepSnapshotReads(id: string) {
            const directory = meta(id);

            if (
              !(yield* fs.exists(directory)) ||
              (yield* fs.realPath(directory)) !== directory
            ) {
              return;
            }

            for (const entry of yield* fs.readDirectory(directory)) {
              if (entry.startsWith("snapshot-read-")) {
                const staging = path.join(directory, entry);

                if ((yield* fs.lstat(staging)).type === "Directory") {
                  yield* fs.remove(staging, { recursive: true });
                }
              }
            }
          }
        );

        for (const entry of yield* fs.readDirectory(config.metadata)) {
          if (
            Schema.is(PeonId)(entry) &&
            (yield* fs.lstat(meta(entry))).type === "Directory"
          ) {
            yield* sweepSnapshotReads(entry);
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
                      "Box is busy or not stopped; simultaneous prompts or lifecycle changes could corrupt its session. GET /v1/boxes/{id}, then retry after the active request finishes.",
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

        const prepareTree = (id: string) =>
          execute({
            args: ["-R", "u+rwX,g+rwX,o-rwx", base(id)],
            executable: "chmod",
          });

        const managerUid = (yield* execute({
          executable: "id",
          args: ["-u"],
        })).trim();

        const acceptTraversal = Effect.fn("Boxes.acceptTraversal")(
          function* acceptTraversal(
            output: ProcessOutput,
            root: string,
            stage: string
          ) {
            const diagnostics = (output.stderr ?? "")
              .trim()
              .split("\n")
              .filter(Boolean);

            const unreadableOwnerSubtrees =
              output.exit === 1 &&
              diagnostics.length > 0 &&
              diagnostics.every((line) => {
                const denied =
                  /^(?:\/usr\/bin\/)?find: '(?<path>[^']+)': Permission denied$/u.exec(
                    line
                  )?.[1];

                return (
                  denied !== undefined &&
                  (denied === root || denied.startsWith(`${root}/`))
                );
              });

            if (
              !(output.exit === 0 && diagnostics.length === 0) &&
              !unreadableOwnerSubtrees
            ) {
              return yield* refusal(
                `Box ${stage} recovery failed (exit ${output.exit}): ${diagnosticOf(output.stderr)}; continuing could leave a partially transferred tree unreadable. Check the owner chmod and CHOWN-only find helpers, then retry GET /v1/boxes/{id} before copying or deleting it.`,
                503
              );
            }

            return yield* Effect.void;
          }
        );

        const regrant = Effect.fn("Boxes.regrant")(function* regrant(
          id: string
        ) {
          const granted = yield* runner.run({
            executable: "env",
            args: [
              "LC_ALL=C",
              "find",
              base(id),
              "-xdev",
              "-user",
              managerUid,
              "!",
              "-type",
              "l",
              "-exec",
              "chmod",
              "u+rwX,g+rwX,o-rwx",
              "{}",
              "+",
            ],
          });

          yield* acceptTraversal(granted, base(id), "manager permissions");

          const recovered = yield* runner.run({
            executable: "docker",
            args: [
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
              `0:${config.gid}`,
              "--env",
              "LC_ALL=C",
              "--mount",
              `type=bind,source=${base(id)},target=/box`,
              "--entrypoint",
              "/usr/bin/find",
              config.image,
              "/box",
              "-xdev",
              "-depth",
              "(",
              "-user",
              "0",
              "-o",
              "-user",
              managerUid,
              ")",
              "-exec",
              "/bin/chown",
              "-h",
              `65534:${config.gid}`,
              "{}",
              "+",
            ],
          });

          yield* acceptTraversal(recovered, "/box", "root ownership");

          yield* docker([
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            `65534:${config.gid}`,
            "--mount",
            `type=bind,source=${base(id)},target=/box`,
            "--entrypoint",
            "/bin/chmod",
            config.image,
            "-R",
            "u+rwX,g+rwX,o-rwx",
            "/box",
          ]);

          return yield* Effect.void;
        });

        const owned = (id: string, initialize = false) =>
          runner
            .run({
              executable: "docker",
              args: [
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
                `0:${config.gid}`,
                "--mount",
                `type=bind,source=${base(id)},target=/box`,
                "--entrypoint",
                "/bin/sh",
                config.image,
                "-c",
                `chown -hR 0:${config.gid} /box && ${initialize ? `cp /opt/peon/models.json /opt/peon/settings.json /box/home/${agentDirs.PI_CODING_AGENT_DIR}/ && ` : ""}chmod -R g+rwX /box && chown -hR 65534:${config.gid} /box`,
              ],
            })
            .pipe(
              Effect.flatMap((output) => {
                if (output.exit === 0) {
                  return Effect.void;
                }

                const diagnostic = diagnosticOf(output.stderr);

                return refusal(
                  `Box ownership preparation failed (exit ${output.exit}): ${diagnostic}. uid 65534 needs a writable workspace and the manager gid needs snapshot/delete access. Check the isolated CHOWN helper and retry.`,
                  503
                );
              })
            );

        const gitName = "shitratgit[bot]";
        const gitEmail = "286405550+shitratgit[bot]@users.noreply.github.com";

        const launchArgs = (template: BoxMetadata["template"]) =>
          browserArgs(template, config.browserBuildRoot ?? "").pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(Runner, runner)
          );

        const container = (
          box: BoxMetadata,
          start: boolean,
          launch: readonly string[]
        ) =>
          docker([
            "create",
            "--name",
            containerOf(box.peonId),
            "--network",
            "mischief-peon-boxes",
            "--cgroup-parent",
            "mischief-peon-boxes.slice",
            "--read-only",
            "--tmpfs",
            `/tmp:rw,nosuid,nodev,size=${box.template.limits.tmp}`,
            ...DNS_WITHOUT_LAN_ROUTER_FORWARDING,
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            `65534:${config.gid}`,
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
            ...[
              "TMPDIR=/tmp",
              "XDG_CACHE_HOME=/home/peon/.cache",
              "XDG_CONFIG_HOME=/home/peon/.config",
              "XDG_DATA_HOME=/home/peon/.local/share",
              "XDG_STATE_HOME=/home/peon/.local/state",
              "npm_config_cache=/home/peon/.cache/npm",
              "npm_config_prefix=/home/peon/.local",
              "PNPM_HOME=/home/peon/.local/share/pnpm",
              "npm_config_store_dir=/home/peon/.local/share/pnpm/store",
              "PIP_CACHE_DIR=/home/peon/.cache/pip",
              "PYTHONUSERBASE=/home/peon/.local",
              "COREPACK_HOME=/home/peon/.cache/corepack",
              "DISABLE_AUTOUPDATER=1",
              `GIT_AUTHOR_NAME=${gitName}`,
              `GIT_AUTHOR_EMAIL=${gitEmail}`,
              `GIT_COMMITTER_NAME=${gitName}`,
              `GIT_COMMITTER_EMAIL=${gitEmail}`,
              ...Object.entries(agentDirs).map(
                ([key, value]) => `${key}=/home/peon/${value}`
              ),
            ].flatMap((value) => ["--env", value]),
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
            ...launch,
            ...(box.template.imageKey === "browser"
              ? ["--label", BROWSER_LABEL]
              : []),
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

        const stop = Effect.fn("Boxes.stop")(function* stop(id: string) {
          yield* docker(["stop", containerOf(id)]);
          const stopped = yield* ready(id);

          if (stopped.Running || stopped.Pid !== 0) {
            return yield* refusal(
              "Suspend left a live process; claiming sleep would hide resource use. Inspect Docker state and retry suspend.",
              503
            );
          }

          return yield* Effect.void;
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

          const snapshot = yield* snapshotPath(box);

          if ((yield* hash(snapshot.path)) !== snapshot.sha256) {
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
            args: ["--no-same-owner", "-xf", snapshot.path, "-C", base(target)],
            executable: "tar",
          });
          yield* prepareTree(target);
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

          const sleeping =
            box.state === "hibernated" ? "hibernated" : "suspended";

          return yield* Effect.gen(function* wakeBrowserOrFull() {
            const restored = sleeping === "hibernated";

            if (restored) {
              const launch = yield* launchArgs(box.template);
              yield* restore(box, box.peonId);
              yield* container(box, false, launch);
            }

            yield* docker(["start", containerOf(box.peonId)]);

            if (!(yield* ready(box.peonId)).Running) {
              return yield* refusal(
                "Docker start did not leave the box running. Inspect its exit state, then retry resume.",
                503
              );
            }

            const { snapshot, ...metadata } = box;

            const updated =
              snapshot === undefined
                ? { ...metadata, state }
                : {
                    ...metadata,
                    state,
                    snapshot: {
                      bytes: snapshot.bytes,
                      path: snapshot.path,
                      sha256: snapshot.sha256,
                    },
                  };

            yield* save(updated);

            return { box: updated, restored };
          }).pipe(withBrowserCapacity(box.template, box.peonId, sleeping));
        });

        const containerPresent = (id: string) =>
          docker([
            "ps",
            "-a",
            "--filter",
            `name=^/${containerOf(id)}$`,
            "--format",
            "{{.Names}}",
          ]).pipe(Effect.map((output) => output.trim() !== ""));

        const snapshotRoot = Effect.fn("Boxes.snapshotRoot")(
          function* snapshotRoot() {
            const root = yield* fs.realPath(config.snapshots);

            if (root !== config.snapshots) {
              return yield* refusal(
                "Snapshot storage is not canonical. Restore the original snapshot root before retrying.",
                503
              );
            }

            return root;
          }
        );

        const snapshotPath = Effect.fn("Boxes.snapshotPath")(
          function* snapshotPath(
            box: BoxMetadata,
            canonical: SnapshotRoot = snapshotRoot()
          ) {
            const { snapshot } = box;
            const root = yield* canonical;

            if (
              snapshot === undefined ||
              path.dirname(snapshot.path) !== path.join(root, box.peonId) ||
              (yield* fs.lstat(snapshot.path)).type !== "File" ||
              (yield* fs.realPath(snapshot.path)) !== snapshot.path
            ) {
              return yield* refusal(
                "Box has no canonical recorded hibernation snapshot. Recover the original snapshot before retrying.",
                409
              );
            }

            return snapshot;
          }
        );

        const extractSnapshot = Effect.fn("Boxes.extractSnapshot")(
          function* extractSnapshot(
            box: BoxMetadata,
            part: "home" | "work",
            canonical?: SnapshotRoot
          ) {
            const snapshot = yield* snapshotPath(box, canonical);

            if ((yield* hash(snapshot.path)) !== snapshot.sha256) {
              return yield* refusal(
                "Recorded hibernation snapshot SHA differs. Recover the original before retrying.",
                409
              );
            }

            const staging = yield* fs.makeTempDirectoryScoped({
              directory: meta(box.peonId),
              prefix: "snapshot-read-",
            });

            yield* execute({
              executable: "tar",
              args: [
                "--no-same-owner",
                ...(part === "work" ? ["--same-permissions"] : []),
                "-xf",
                snapshot.path,
                "-C",
                staging,
                "--",
                part,
              ],
            });

            return path.join(staging, part);
          }
        );

        const archiveSource = Effect.fn("Boxes.archiveSource")(
          function* archiveSource(
            box: BoxMetadata,
            row?: string,
            canonical?: SnapshotRoot
          ) {
            const id = box.peonId;
            let source = home(id);

            if (box.state === "hibernated") {
              if (
                (yield* containerPresent(id)) ||
                (yield* fs.exists(base(id)))
              ) {
                return yield* refusal(
                  "Hibernated box still has a container or live tree. Reconcile the interrupted lifecycle before exporting history.",
                  409
                );
              }

              source = yield* extractSnapshot(box, "home", canonical);
            } else {
              const status = (yield* containerPresent(id))
                ? yield* ready(id)
                : undefined;

              if (
                box.state !== "suspended" ||
                (status !== undefined && (status.Running || status.Pid !== 0))
              ) {
                return yield* refusal(
                  `Box ${id} is not stopped; Pi may still be writing its session. POST /v1/boxes/${id}/export to stop an idle box before destroying it.`,
                  409
                );
              }

              yield* regrant(id);
            }

            const identity = {
              boxId: containerOf(id),
              host: hostname().split(".")[0] ?? hostname(),
            };

            const snapshotHome =
              box.state !== "hibernated" && box.snapshot !== undefined
                ? yield* extractSnapshot(box, "home", canonical)
                : undefined;

            return yield* collectArchive(
              source,
              box,
              row === undefined ? identity : { ...identity, row },
              snapshotHome
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.mapError(archiveRefusal)
            );
          }
        );

        const openCustody = archive.open.pipe(Effect.mapError(archiveError));

        const publishArchive = Effect.fn("Boxes.publishArchive")(
          function* publishArchive(
            box: BoxMetadata,
            { files, manifest }: ArchiveSource,
            custody: OpenArchive
          ) {
            const latest = latestImmutableArchive(box);

            const receipt = yield* custody
              .put(
                latest === undefined
                  ? manifest
                  : linkManifest(manifest, latest),
                files
              )
              .pipe(Effect.mapError(archiveError));

            const proof = yield* custody
              .readBack(receipt, "publish")
              .pipe(Effect.mapError(archiveError));

            if (!ReadBackResult.$is("Verified")(proof)) {
              return yield* mismatch(
                box.peonId,
                `Primary archive read-back did not match: ${proof.reason}`
              );
            }

            const updated = { ...box, archive: receipt };
            yield* save(updated);

            return { box: updated, exportReceipt: proof.exportReceipt };
          }
        );

        const parkArchive = Effect.fn("Boxes.parkArchive")(
          function* parkArchive(box: BoxMetadata, row?: string) {
            if (archive.disabled === true) {
              return { parkExport: "disabled" } satisfies typeof Result.Type;
            }

            const source = yield* archiveSource(box, row);
            const current = currentArchive(box, source);

            if (
              current !== undefined &&
              (yield* archive.primaryReceiptExists(current))
            ) {
              return { parkExport: "unchanged" } satisfies typeof Result.Type;
            }

            const { exportReceipt } = yield* publishArchive(
              box,
              source,
              yield* openCustody
            );

            return {
              exportReceipt,
              parkExport:
                source.manifest.skipped.length === 0
                  ? "exported"
                  : "incomplete",
            } satisfies typeof Result.Type;
          },
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: config.parkArchiveTimeout ?? "5 minutes",
            orElse: () =>
              Effect.logWarning(
                "Park archive timed out; retry on the next park or DELETE"
              ).pipe(
                Effect.as({
                  parkExport: "failed",
                  parkExportFailure: "timeout",
                } satisfies typeof Result.Type)
              ),
          }),
          Effect.catch(({ _tag }) =>
            Effect.logWarning(
              "Park archive failed; retry on the next park or DELETE"
            ).pipe(
              Effect.annotateLogs({ failure: _tag }),
              Effect.as({ parkExport: "failed" } satisfies typeof Result.Type)
            )
          ),
          Effect.catchDefect((defect) =>
            Effect.logError(
              "Park archive defect; retry on the next park or DELETE"
            ).pipe(
              Effect.annotateLogs({
                cause: diagnosticOf(Cause.pretty(Cause.die(defect))),
              }),
              Effect.as({ parkExport: "failed" } satisfies typeof Result.Type)
            )
          )
        );

        const exportBox = Effect.fn("Boxes.export")(function* exportBox(
          id: string,
          row?: string
        ) {
          let box = yield* load(id);

          if (box.destroying !== undefined) {
            return yield* inProgress(box.destroying);
          }

          if (box.state === "running") {
            return yield* refusal(
              "Box is not stopped; wait for the active Pi prompt to exit, then retry export.",
              409
            );
          }

          const state = yield* nextState(box.state, "EXPORT");

          if (box.state === "idle") {
            yield* stop(id);
            box = { ...box, state };
            yield* save(box);
          }

          const source = yield* archiveSource(box, row);
          const custody = yield* openCustody;
          const current = currentArchive(box, source);

          if (current !== undefined) {
            const previous = yield* custody
              .readBack(current, "primary")
              .pipe(Effect.mapError(archiveError));

            if (ReadBackResult.$is("Verified")(previous)) {
              return { exportReceipt: previous.exportReceipt, state };
            }
          }

          const { exportReceipt } = yield* publishArchive(box, source, custody);

          return { exportReceipt, state };
        }, Effect.scoped);

        const proveArchive = Effect.fn("Boxes.proveArchive")(
          function* proveArchive(box: BoxMetadata, custody: OpenArchive) {
            const receipt = latestImmutableArchive(box);

            if (receipt === undefined) {
              return yield* needsExport(box.peonId);
            }

            const proof = yield* custody
              .readBack(receipt, "check")
              .pipe(Effect.mapError(archiveError));

            if (ReadBackResult.$is("ReplicaPending")(proof)) {
              return yield* new ReplicaPending({
                archiveId: archiveId(receipt),
                message: proof.reason,
                status: 409,
              });
            }

            if (ReadBackResult.$is("ReplicaMismatch")(proof)) {
              return yield* new ReplicaMismatch({
                archiveId: archiveId(receipt),
                message: proof.reason,
                status: 409,
              });
            }

            if (ReadBackResult.$is("Mismatch")(proof)) {
              return yield* mismatch(
                box.peonId,
                `Cannot verify primary custody: ${proof.reason}`
              );
            }

            return proof.exportReceipt;
          }
        );

        const authorizeWorkspace = Effect.fn("Boxes.authorizeWorkspace")(
          function* authorizeWorkspace(
            box: BoxMetadata,
            input: typeof Action.Type,
            canonical: SnapshotRoot
          ) {
            const { landedHead } = input;

            if (input.discardWorkspace === true && landedHead === undefined) {
              yield* Effect.logInfo(
                "Explicit peon workspace discard authorized"
              ).pipe(
                Effect.annotateLogs({
                  box: box.peonId,
                  requester: input.row ?? "authenticated box client",
                  requestId: input.requestId ?? "",
                })
              );

              return { abandoned: [], ignored: 0 };
            }

            if (landedHead === undefined || input.discardWorkspace === true) {
              return yield* unlanded(
                "Workspace teardown requires exactly one disposition."
              );
            }

            const verify = (directory: string) =>
              verifyWorkspace(
                directory,
                landedHead,
                box.image,
                managerUid,
                config.gid
              ).pipe(
                Effect.provideService(Runner, runner),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path)
              );

            return box.state === "hibernated"
              ? yield* Effect.scoped(
                  extractSnapshot(box, "work", canonical).pipe(
                    Effect.flatMap(verify)
                  )
                )
              : yield* verify(work(box.peonId));
          }
        );

        const beginDestroy = Effect.fn("Boxes.beginDestroy")(
          function* beginDestroy(
            original: BoxMetadata,
            input: typeof Action.Type,
            custody: OpenArchive,
            canonical: SnapshotRoot
          ) {
            const id = original.peonId;

            if (original.state === "idle") {
              if (latestImmutableArchive(original) === undefined) {
                return yield* needsExport(id);
              }

              return yield* mismatch(
                id,
                "Box is not stopped; export must suspend it before destroy."
              );
            }

            yield* nextState(original.state, "DESTROY");

            const box = yield* Effect.scoped(
              Effect.gen(function* refreshArchive() {
                const source = yield* archiveSource(
                  original,
                  input.row,
                  canonical
                );

                const { skipped } = source.manifest;

                if (skipped.length > 0) {
                  return yield* new CustodyIncomplete({
                    skipped,
                    message: `Some session files were skipped. Recover them and POST /v1/boxes/${id}/export before destroying.`,
                    status: 409,
                  });
                }

                if (currentArchive(original, source) !== undefined) {
                  return original;
                }

                return (yield* publishArchive(original, source, custody)).box;
              })
            );

            const proof = yield* proveArchive(box, custody);

            const retainSnapshot =
              input.retained ?? box.snapshot?.retained === true;

            if (retainSnapshot && box.state !== "hibernated") {
              return yield* unlanded(
                "Hibernate the current workspace before retaining it."
              );
            }

            const snapshot =
              box.snapshot === undefined
                ? undefined
                : yield* snapshotPath(box, canonical);

            const { requestId } = input;
            const disposition = dispositionOf(input);

            if (disposition === undefined || requestId === undefined) {
              return yield* unlanded(
                "Workspace teardown requires exactly one disposition and a requestId."
              );
            }

            const workspace = yield* authorizeWorkspace(box, input, canonical);

            const bytesFreed =
              (yield* size(base(id))) +
              (retainSnapshot ? 0 : (snapshot?.bytes ?? 0));

            const marker = {
              ...workspace,
              ...supersededWork(
                box.state === "hibernated" ? undefined : snapshot?.bytes
              ),
              bytesFreed,
              disposition,
              requestId,
              receiptId: proof.id,
              retainSnapshot,
            };

            yield* save({ ...box, destroying: marker });

            return { exportReceipt: proof, marker };
          }
        );

        const destroyBox = Effect.fn("Boxes.destroy")(function* destroyBox(
          box: BoxMetadata,
          input: typeof Action.Type
        ) {
          if (box.state === "destroyed") {
            return (
              box.tombstone ??
              Tombstone.make({
                state: "destroyed",
                bytesFreed: 0,
                snapshotKept: box.snapshot !== undefined,
              })
            );
          }

          const id = box.peonId;

          if (
            box.destroying !== undefined &&
            (box.destroying.disposition !== dispositionOf(input) ||
              box.destroying.retainSnapshot !==
                (input.retained ?? box.snapshot?.retained === true))
          ) {
            return yield* inProgress(box.destroying);
          }

          const custody = yield* openCustody;

          const canonical =
            box.snapshot === undefined
              ? snapshotRoot()
              : Effect.succeed(yield* snapshotRoot());

          if (
            box.destroying !== undefined &&
            (box.archive === undefined ||
              box.destroying.receiptId !== archiveId(box.archive))
          ) {
            return yield* refusal(
              "Destroy marker does not match the recorded archive receipt. Reconcile host metadata before retrying DELETE.",
              409
            );
          }

          const { exportReceipt, marker } =
            box.destroying === undefined
              ? yield* beginDestroy(box, input, custody, canonical)
              : {
                  exportReceipt: yield* proveArchive(box, custody),
                  marker: box.destroying,
                };

          yield* execute({ args: ["-f", meta(id)], executable: "sync" });
          yield* sweepSnapshotReads(id);

          if (yield* containerPresent(id)) {
            yield* docker(["rm", "--force", containerOf(id)]).pipe(
              Effect.catch((error) =>
                containerPresent(id).pipe(
                  Effect.flatMap((present) =>
                    present ? Effect.fail(error) : Effect.void
                  )
                )
              )
            );
          }

          if (yield* fs.exists(base(id))) {
            yield* regrant(id);
            yield* owned(id);
            yield* fs.remove(base(id), { recursive: true });
          }

          const { snapshot, destroying: _destroying, ...metadata } = box;

          if (!marker.retainSnapshot && snapshot !== undefined) {
            yield* canonical;

            if (yield* fs.exists(snapshot.path)) {
              yield* snapshotPath(box, canonical);
              yield* fs.remove(snapshot.path);
            }
          }

          const tombstone = Tombstone.make({
            abandoned: marker.abandoned,
            ignored: marker.ignored,
            bytesFreed: marker.bytesFreed,
            exportReceipt,
            snapshotKept: marker.retainSnapshot,
            ...supersededWork(marker.snapshotBytes),
            state: "destroyed",
          });

          const finished = { ...metadata, state: tombstone.state, tombstone };
          yield* save(
            marker.retainSnapshot && snapshot !== undefined
              ? { ...finished, snapshot: { ...snapshot, retained: true } }
              : finished
          );

          return tombstone;
        });

        const promptFailure = Effect.fn("Boxes.promptFailure")(
          function* promptFailure(id: string, error: BridgeFailure) {
            const state = yield* load(id).pipe(
              Effect.map((box) => box.state),
              Effect.catch(() => Effect.succeed(undefined))
            );

            const failure = { message: error.message, status: error.status };

            return yield* new PromptFailed(
              Schema.is(PeonState)(state) ? { ...failure, state } : failure
            );
          }
        );

        const request = Effect.fn("Boxes.request")(function* request<E>(
          id: string,
          requestId: string,
          committedFailure: (error: BridgeFailure) => Effect.Effect<never, E>,
          operation: Effect.Effect<
            typeof Result.Type,
            BridgeFailure | BoxCapacity | PlatformError.PlatformError
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
              return yield* committedFailure(receipt.error);
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
              onFailure: (
                error
              ): Effect.Effect<
                never,
                E | BoxCapacity | PlatformError.PlatformError
              > =>
                Predicate.isTagged(error, "BoxCapacity")
                  ? fs.remove(file).pipe(Effect.andThen(Effect.fail(error)))
                  : writeJson(file, { error, requestId }).pipe(
                      Effect.andThen(committedFailure(error))
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
                Effect.fail,
                Effect.gen(function* createBox() {
                  if (yield* fs.exists(metadataPath(id))) {
                    return yield* refusal(
                      `Box ${id} already exists; replacing it would discard its session. GET /v1/boxes/${id} or choose a new peonId.`,
                      409
                    );
                  }

                  const image = images[template.imageKey ?? "full"];

                  if (image === undefined) {
                    return yield* refusal(
                      "Browser image is not configured. Set the browser entry in MISCHIEF_PEON_BOX_IMAGES to its immutable @sha256 digest and restart before retrying create.",
                      503
                    );
                  }

                  const launch = yield* launchArgs(template);

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

                  const agent = path.join(
                    home(id),
                    agentDirs.PI_CODING_AGENT_DIR
                  );

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

                  yield* prepareTree(id);
                  yield* owned(id, true);

                  const box: BoxMetadata = {
                    image,
                    lastPromptAt: null,
                    peonId: id,
                    state: "idle",
                    template,
                  };

                  yield* container(box, true, launch);
                  yield* save(box);

                  return {
                    image,
                    peonId: id,
                    state: "idle",
                    workspace: template.workspace,
                  };
                }).pipe(withBrowserCapacity(template, id, "spawned"))
              )
            );
          },
          Effect.catchTag("PlatformError", hostFailure)
        );

        const act = Effect.fn("Boxes.act")(
          function* act(input: typeof Action.Type) {
            const id = input.peonId;

            if (input.action === "export") {
              return yield* locked([id], exportBox(id, input.row));
            }

            const { requestId } = input;

            if (requestId === undefined) {
              return yield* refusal(
                "Supply a nonempty requestId for this box lifecycle action."
              );
            }

            if (input.action === "destroy") {
              return yield* locked(
                [id],
                load(id).pipe(Effect.flatMap((box) => destroyBox(box, input)))
              );
            }

            return yield* locked(
              input.action === "clone" && input.newPeonId !== undefined
                ? [id, input.newPeonId]
                : [id],
              request(
                id,
                requestId,
                (error): Effect.Effect<never, BridgeFailure | PromptFailed> =>
                  input.action === "prompt"
                    ? promptFailure(id, error)
                    : Effect.fail(error),
                Effect.gen(function* actBox() {
                  let box = yield* load(id);

                  if (box.destroying !== undefined) {
                    return yield* refusal(
                      inProgress(box.destroying).message,
                      409
                    );
                  }

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

                    const requestKey = yield* keyOf(requestId);

                    const directory = path.join(
                      meta(id),
                      "requests",
                      requestKey
                    );

                    const parked = {
                      ...box,
                      state: "suspended",
                    } satisfies BoxMetadata;

                    return yield* Effect.gen(function* runPrompt() {
                      const result = yield* promptPi(
                        containerOf(id),
                        box.template,
                        text,
                        began,
                        resumeMs,
                        directory
                      ).pipe(
                        Effect.provideService(Runner, runner),
                        Effect.provideService(FileSystem.FileSystem, fs),
                        Effect.provideService(Path.Path, path)
                      );

                      yield* docker(
                        [
                          "exec",
                          "-i",
                          containerOf(id),
                          "node",
                          "--input-type=module",
                          "-e",
                          "import{mkdir,writeFile}from'node:fs/promises';process.umask(0o0007);await mkdir('/home/peon/.box/requests',{recursive:true});const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);await writeFile(process.argv[1],Buffer.concat(chunks))",
                          `/home/peon/.box/requests/${requestKey}.json`,
                        ],
                        JSON.stringify({ requestId, result })
                      );
                      yield* save({
                        ...box,
                        state: yield* nextState(box.state, "DONE"),
                      });

                      return result;
                    }).pipe(
                      Effect.onError(() =>
                        stop(id).pipe(
                          Effect.andThen(save(parked)),
                          Effect.orDie
                        )
                      ),
                      Effect.tapError(() => parkArchive(parked, input.row))
                    );
                  }

                  const state = yield* nextState(
                    box.state,
                    input.action.toUpperCase()
                  );

                  if (input.action === "suspend") {
                    yield* stop(id);

                    const parked = { ...box, state };
                    yield* save(parked);

                    return {
                      state,
                      ...(yield* parkArchive(parked, input.row)),
                    };
                  }

                  if (input.action === "hibernate") {
                    if (box.state === "hibernated") {
                      const previous = box.snapshot;

                      if (
                        input.retained !== undefined &&
                        previous !== undefined
                      ) {
                        const { retained: _retained, ...evidence } =
                          yield* snapshotPath(box);

                        const snapshot = input.retained
                          ? { ...evidence, retained: input.retained }
                          : evidence;

                        yield* save({ ...box, snapshot });

                        return { snapshot, state };
                      }

                      return {
                        snapshot: previous,
                        state,
                        ...(yield* parkArchive(box, input.row)),
                      };
                    }

                    yield* stop(id);
                    yield* regrant(id);
                    yield* owned(id);
                    const directory = path.join(yield* snapshotRoot(), id);
                    yield* fs.makeDirectory(directory, {
                      mode: 0o700,
                      recursive: true,
                    });

                    const file = path.join(
                      directory,
                      `${yield* Clock.currentTimeMillis}-${yield* keyOf(requestId)}.tar`
                    );

                    yield* execute({
                      args: [
                        "--hard-dereference",
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

                    const recorded =
                      input.retained === true
                        ? { ...snapshot, retained: input.retained }
                        : snapshot;

                    const parked = { ...box, snapshot: recorded, state };
                    yield* save(parked);
                    yield* docker(["rm", containerOf(id)]);
                    yield* fs.remove(base(id), { recursive: true });

                    return {
                      snapshot: recorded,
                      state,
                      ...(yield* parkArchive(parked, input.row)),
                    };
                  }

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

                  const launch = yield* launchArgs(box.template);
                  yield* fs.makeDirectory(meta(target), {
                    mode: 0o700,
                    recursive: true,
                  });

                  if (box.state === "hibernated") {
                    yield* restore(box, target);
                  } else {
                    yield* regrant(id);
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
                    yield* prepareTree(target);
                    yield* owned(target);
                  }

                  const clone: BoxMetadata = {
                    image: box.image,
                    lastPromptAt: box.lastPromptAt,
                    peonId: target,
                    state: "suspended",
                    template: box.template,
                  };

                  yield* container(clone, false, launch);
                  yield* save(clone);

                  return { peonId: target, state: "suspended" };
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

              if (
                box.state === "suspended" &&
                (status.Running || status.Pid !== 0)
              ) {
                return yield* refusal(
                  "Suspended box still has a Docker process; its stored state is stale. Inspect Docker state and retry suspend before claiming zero processes.",
                  503
                );
              }

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

            if (yield* fs.exists(base(id))) {
              yield* regrant(id);
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

        const tail = Effect.fn("Boxes.tail")(
          function* tail(id: string, query: typeof PeonTailQuery.Type) {
            yield* Schema.decodeUnknownEffect(PeonId)(id).pipe(
              Effect.mapError(() =>
                refusal(
                  "Invalid peonId. Call listPeons and retry tailPeon with an existing id."
                )
              )
            );
            const box = yield* load(id);

            if (box.peonId !== id) {
              return yield* refusal(
                "Box metadata does not match its id. Check the box record before retrying tailPeon.",
                503
              );
            }

            if (
              box.state === "hibernated" ||
              box.state === "destroyed" ||
              box.state === "absent"
            ) {
              return { reason: box.state, status: "not-live" } as const;
            }

            return yield* readSessionTail(base(box.peonId), query);
          },
          Effect.catchTag("PlatformError", hostFailure)
        );

        return Boxes.of({ act, create, inspect, tail });
      }).pipe(Effect.catchTag("PlatformError", hostFailure))
    );
}
