import assert from "node:assert/strict";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The manual Docker harness runs synchronous host commands outside the product runtime.
import { spawnSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The manual harness validates and creates its scratch directory before acquiring services.
import * as fs from "node:fs";
import { hostname } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Scratch validation must finish before the manual harness starts Docker.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import * as Digest from "effect/crypto/Digest";
import { describe } from "vitest";

import { archiveDiskLayer } from "../src/box/archive-disk.js";
import { Boxes } from "../src/box/manager.js";
import { PromptResult, Result } from "../src/box/protocol.js";
import type { Action, ActionBody, BoxTemplate } from "../src/box/protocol.js";
import { Runner } from "../src/runner.js";

const command = (
  executable: string,
  args: readonly string[],
  input?: string
) => {
  const output = spawnSync(executable, args, {
    encoding: "utf-8",
    input,
    killSignal: "SIGKILL",
    timeout: 30_000,
  });

  assert.ifError(output.error);

  return {
    exit: output.status ?? 1,
    stderr: output.stderr,
    stdout: output.stdout,
  };
};

const checked = (
  executable: string,
  args: readonly string[],
  input?: string
) => {
  const result = command(executable, args, input);
  assert.equal(
    result.exit,
    0,
    `${executable} ${args.join(" ")}: ${result.stderr}`
  );

  return result.stdout.trim();
};

describe.skipIf(process.env.MISCHIEF_REAL_DOCKER_SCRATCH === undefined)(
  "real Docker peon lifecycle",
  () => {
    it.live(
      "recovers permissions and preserves conversations across box lifecycles",
      () =>
        Effect.suspend(() => {
          const scratch = process.env.MISCHIEF_REAL_DOCKER_SCRATCH;
          const image = process.env.MISCHIEF_REAL_DOCKER_IMAGE;
          const prefix = process.env.MISCHIEF_REAL_DOCKER_PREFIX;

          const checkout = fs.realpathSync(
            path.resolve(import.meta.dirname, "../../..")
          );

          assert.ok(scratch !== undefined && path.isAbsolute(scratch));

          assert.ok(scratch.startsWith(`${checkout}/`));
          assert.equal(path.normalize(scratch), scratch);
          assert.match(path.basename(scratch), /^\.mpt-[a-z0-9-]+$/u);

          assert.equal(
            fs.realpathSync(path.dirname(scratch)),
            path.dirname(scratch)
          );

          assert.ok(
            !fs.existsSync(scratch),
            "Scratch must be a new directory owned by this run"
          );

          assert.match(
            checked("stat", ["-f", "-c", "%T", "--", path.dirname(scratch)]),
            /^(?:xfs|ext2\/ext3|btrfs|tmpfs|overlayfs)$/u,
            "Docker fixtures must stay on local scratch storage"
          );
          assert.equal(image, "mischief-peon-full:ab95d63");

          assert.ok(prefix !== undefined && /^mpt-[a-z0-9-]+$/u.test(prefix));

          const labelKey = "sh.mischief.lifecycle-test";
          const label = `${labelKey}=${prefix}`;
          const names = new Set<string>();

          const removeOwned = (name: string) => {
            assert.ok(name.startsWith(prefix));

            const inspected = command("docker", [
              "container",
              "inspect",
              "--format",
              `{{index .Config.Labels "${labelKey}"}}`,
              name,
            ]);

            if (inspected.exit !== 0) {
              assert.match(inspected.stderr, /No such (?:container|object)/u);

              return;
            }

            assert.equal(inspected.stdout.trim(), prefix);
            checked("docker", ["rm", "--force", name]);
          };

          let helper = 0;

          let step = "setup";

          const inspectedImage = command("docker", [
            "image",
            "inspect",
            image,
            "--format",
            "{{.Id}}",
          ]);

          assert.equal(
            inspectedImage.exit,
            0,
            `Required local image ${image} could not be inspected; it must be present before starting (no pulls): ${inspectedImage.stderr}`
          );
          const imageId = inspectedImage.stdout.trim();
          assert.match(imageId, /^sha256:[0-9a-f]{64}$/u);

          const pinned = `mischief-peon-full@${imageId}`;
          process.stdout.write(
            `Docker proof image ${imageId}; label ${label}\n`
          );

          const gid = Number(checked("id", ["-g"]));

          const uid = Number(checked("id", ["-u"]));

          const physical = (id: string) => `${prefix}${id}`;

          const nextKey = () => {
            helper += 1;

            return helper;
          };

          const Inspection = Schema.Struct({
            bytes: Schema.Struct({
              home: Schema.Finite,
              work: Schema.Finite,
              snapshot: Schema.Finite,
            }),
            processes: Schema.Finite,
            state: Schema.String,
          });

          const ProcessOutput = Schema.Struct({
            exit: Schema.Int,
            stderr: Schema.optionalKey(Schema.String),
            stdout: Schema.String,
          });

          const DockerState = Schema.Struct({
            Running: Schema.Boolean,
            Pid: Schema.Finite,
          });

          const runner = Runner.of({
            run: (request) =>
              Effect.sync(() => {
                if (request.executable !== "docker") {
                  return command(
                    request.executable,
                    request.args,
                    request.input
                  );
                }

                const args = [];

                for (let index = 0; index < request.args.length; index += 1) {
                  let arg = request.args[index] ?? "";

                  if (arg === "--cgroup-parent") {
                    index += 1;
                    continue;
                  }

                  if (arg === "mischief-peon-boxes") {
                    arg = "none";
                  }

                  if (arg === pinned) {
                    arg = imageId;
                  }

                  if (arg.startsWith("mischief-peon-box-")) {
                    arg = physical(arg.slice("mischief-peon-box-".length));
                  } else if (arg.startsWith("name=^/mischief-peon-box-")) {
                    arg = `name=^/${physical(arg.slice("name=^/mischief-peon-box-".length, -1))}$`;
                  }

                  if (arg === 'umask 0007; exec pi "$@"') {
                    arg = 'umask 0007; exec /home/peon/fake-pi "$@"';
                  }

                  args.push(arg);
                }

                if (args[0] === "run") {
                  args.splice(1, 0, "--name", `${prefix}helper-${nextKey()}`);
                }

                if (args[0] === "create" || args[0] === "run") {
                  const name = args[args.indexOf("--name") + 1] ?? "";
                  assert.ok(name.startsWith(prefix));
                  names.add(name);
                  args.splice(1, 0, "--label", label, "--pull", "never");
                }

                return command("docker", args, request.input);
              }),
          });

          const fakePi = `#!/bin/sh
set -eu
cache=0
if [ -s /home/peon/session.jsonl ]; then
  cache=17
else
  printf '%s\\n' '{"type":"session","version":3,"id":"f4f15679-4146-4f95-8917-09c60abe812b","timestamp":"2026-01-01T00:00:00Z","cwd":"/work"}' > /home/peon/session.jsonl
fi
input="$(cat)"
printf '%s\\n' "$input" >> /home/peon/session.jsonl
printf 'tool output\\n' > /work/result.txt
for directory in .claude/projects .claude/sessions .claude/plugins .pi/agent/claude-bridge; do
  mkdir -p "/home/peon/$directory"
  chmod 700 "/home/peon/$directory"
  printf 'private state\\n' > "/home/peon/$directory/state"
done
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"fake memory intact"}],"stopReason":"stop","usage":{"input":1,"output":1,"cacheRead":%s,"cacheWrite":0}}}\\n' "$cache"
`;

          fs.mkdirSync(scratch, { mode: 0o770 });

          return Effect.suspend(() => {
            const mirror = `${scratch}/mirror`;
            checked("git", ["init", mirror]);
            fs.writeFileSync(`${mirror}/proof.txt`, "pinned fixture\n");
            checked("git", ["-C", mirror, "add", "proof.txt"]);
            checked("git", [
              "-C",
              mirror,
              "-c",
              "user.name=fixture",
              "-c",
              "user.email=fixture@example.invalid",
              "commit",
              "-m",
              "fixture",
            ]);
            const sha = checked("git", ["-C", mirror, "rev-parse", "HEAD"]);

            const primary = `${scratch}/primary`;
            const replica = `${scratch}/replica`;
            fs.mkdirSync(primary);
            fs.mkdirSync(replica);

            const config = {
              gid,
              image: pinned,
              metadata: `${scratch}/metadata`,
              mount: scratch,
              mirrors: { "fixture/repo": mirror },
              root: `${scratch}/boxes`,
              snapshots: `${scratch}/snapshots`,
            };

            const template: BoxTemplate = {
              limits: { cpus: 1, memory: "1g", pids: 128, tmp: "64m" },
              model: "opus",
              thinking: "medium",
              tools: "all",
              workspace: { repo: "fixture/repo", sha },
            };

            return Effect.gen(function* lifecycle() {
              const boxes = yield* Boxes;

              const failOldHelper = Effect.fn("Manual.failOldHelper")(
                function* failOldHelper(id: string) {
                  step = `${id} plant old failing helper`;

                  const result = yield* runner.run({
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
                      `0:${gid}`,
                      "--mount",
                      `type=bind,source=${scratch}/boxes/${id},target=/box`,
                      "--entrypoint",
                      "/bin/sh",
                      pinned,
                      "-c",
                      `chown -hR 0:${gid} /box && chmod -R g+rwX /box && chown -hR 65534:${gid} /box`,
                    ],
                  });

                  const failed =
                    yield* Schema.decodeUnknownEffect(ProcessOutput)(result);

                  assert.notEqual(failed.exit, 0);
                  assert.match(failed.stderr ?? "", /Permission denied/u);
                  assert.equal(fs.statSync(`${scratch}/boxes/${id}`).uid, 0);
                  yield* Effect.log(
                    `PASS old helper failed with partially root-owned ${id}`
                  );
                }
              );

              const assertRecovered = Effect.fn("Manual.assertRecovered")(
                function* assertRecovered(id: string) {
                  step = `${id} verify recovered ownership`;

                  const result = yield* runner.run({
                    executable: "docker",
                    args: [
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
                      `0:${gid}`,
                      "--mount",
                      `type=bind,source=${scratch}/boxes/${id},target=/box`,
                      "--entrypoint",
                      "/usr/bin/find",
                      pinned,
                      "/box",
                      "-xdev",
                      "(",
                      "-user",
                      "0",
                      "-o",
                      "-user",
                      String(uid),
                      ")",
                      "-print",
                    ],
                  });

                  const found =
                    yield* Schema.decodeUnknownEffect(ProcessOutput)(result);

                  assert.equal(found.exit, 0, found.stderr);
                  assert.equal(found.stdout.trim(), "", found.stdout);
                  yield* Effect.log(
                    `PASS ${id}: full post-regrant walk has no root or manager-owned entries`
                  );
                }
              );

              const makeManagerOwned = Effect.fn("Manual.makeManagerOwned")(
                function* makeManagerOwned(id: string) {
                  step = `${id} plant manager-owned tree`;

                  const result = yield* runner.run({
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
                      `0:${gid}`,
                      "--mount",
                      `type=bind,source=${scratch}/boxes/${id},target=/box`,
                      "--entrypoint",
                      "/bin/chown",
                      pinned,
                      "-hR",
                      `${uid}:${gid}`,
                      "/box",
                    ],
                  });

                  const transferred =
                    yield* Schema.decodeUnknownEffect(ProcessOutput)(result);

                  assert.equal(transferred.exit, 0, transferred.stderr);
                  checked("chmod", ["-R", "700", `${scratch}/boxes/${id}`]);
                  assert.equal(fs.statSync(`${scratch}/boxes/${id}`).uid, uid);
                  yield* Effect.log(
                    `PASS planted all-manager-owned 700 tree for ${id}`
                  );
                }
              );

              const act = (
                id: string,
                action: (typeof Action.Type)["action"],
                extra: typeof ActionBody.Type = {}
              ) => {
                step = `${id} ${action}`;

                const request = {
                  peonId: id,
                  action,
                  requestId: `${id}-${action}-${nextKey()}`,
                  ...extra,
                };

                return action === "destroy" && extra.landedHead === undefined
                  ? boxes.act({ ...request, discardWorkspace: true })
                  : boxes.act(request);
              };

              const exportBox = Effect.fn("Manual.exportBox")(
                function* exportBox(id: string, replicate?: boolean) {
                  const { exportReceipt } = yield* Schema.decodeUnknownEffect(
                    Result
                  )(yield* act(id, "export"));

                  assert.ok(exportReceipt);
                  assert.equal(exportReceipt.replicaState, "pending");

                  if (replicate !== false) {
                    checked("rsync", [
                      "-a",
                      "--",
                      `${primary}/`,
                      `${replica}/`,
                    ]);
                  }

                  return exportReceipt;
                }
              );

              const inspect = (id: string) =>
                Effect.gen(function* inspectBox() {
                  step = `${id} inspect`;

                  const report = yield* Schema.decodeUnknownEffect(Inspection)(
                    yield* boxes.inspect(id)
                  );

                  yield* Effect.log(JSON.stringify({ id, ...report }));

                  return report;
                });

              step = "source spawn";
              yield* boxes.create({
                peonId: "source",
                requestId: "spawn",
                template,
              });
              step = "source install fake Pi";
              checked(
                "docker",
                [
                  "exec",
                  "-i",
                  physical("source"),
                  "/bin/sh",
                  "-c",
                  "cat > /home/peon/fake-pi && chmod 770 /home/peon/fake-pi",
                ],
                fakePi
              );
              yield* act("source", "prompt", {
                text: "remember this conversation",
              });
              yield* Effect.log("PASS spawn and uid 65534 mode-700 writes");

              for (const state of ["idle", "suspended"]) {
                if (state === "idle") {
                  yield* failOldHelper("source");
                }

                if (state === "suspended") {
                  yield* act("source", "suspend");

                  const dockerState = yield* Schema.decodeEffect(
                    Schema.fromJsonString(DockerState)
                  )(
                    checked("docker", [
                      "inspect",
                      "--format",
                      "{{json .State}}",
                      physical("source"),
                    ])
                  );

                  assert.equal(dockerState.Running, false);
                  assert.equal(dockerState.Pid, 0);
                  assert.equal((yield* inspect("source")).processes, 0);
                  yield* Effect.log(
                    "PASS suspend: Running=false Pid=0 processes=0"
                  );
                }

                const id = `copy-${state}`;
                yield* act("source", "clone", { newPeonId: id });
                assert.equal((yield* inspect(id)).state, "suspended");
                yield* assertRecovered("source");
                yield* assertRecovered(id);

                const turn = yield* Schema.decodeUnknownEffect(PromptResult)(
                  yield* act(id, "prompt", {
                    text: "continue the conversation",
                  })
                );

                assert.ok(turn.resumeMs > 0);
                assert.equal(turn.usage.cacheRead, 17);
                assert.match(
                  checked("docker", [
                    "exec",
                    physical(id),
                    "cat",
                    "/home/peon/session.jsonl",
                  ]),
                  /remember this conversation/u
                );
                yield* Effect.log(
                  `PASS clone from ${state}; fake cacheRead=${turn.usage.cacheRead} resumeMs=${turn.resumeMs}`
                );
                yield* failOldHelper(id);
                yield* exportBox(id);
                yield* act(id, "destroy");
                yield* Effect.log(
                  `PASS delete recovers partial ownership for ${id}`
                );
              }

              const woke = yield* Schema.decodeUnknownEffect(PromptResult)(
                yield* act("source", "prompt", { text: "wake source" })
              );

              assert.ok(woke.resumeMs > 0);
              yield* Effect.log(
                `PASS prompt resumes stopped source; resumeMs=${woke.resumeMs}`
              );
              yield* failOldHelper("source");
              yield* act("source", "hibernate");
              const slept = yield* inspect("source");
              assert.equal(slept.state, "hibernated");
              assert.ok(slept.bytes.snapshot > 0);
              assert.equal(slept.bytes.home, 0);
              assert.equal(slept.bytes.work, 0);
              yield* Effect.log("PASS snapshot and hibernate");
              yield* act("source", "resume");
              const restored = yield* inspect("source");
              assert.ok(restored.bytes.home > 0 && restored.bytes.work > 0);
              assert.match(
                checked("docker", [
                  "exec",
                  physical("source"),
                  "cat",
                  "/home/peon/session.jsonl",
                ]),
                /remember this conversation/u
              );
              yield* assertRecovered("source");
              yield* Effect.log("PASS restore preserves conversation");
              yield* act("source", "hibernate");
              yield* exportBox("source");
              yield* act("source", "destroy");
              assert.equal((yield* inspect("source")).state, "destroyed");
              yield* Effect.log("PASS delete; no model calls made");
              step = "manager-source spawn";
              yield* boxes.create({
                peonId: "manager-source",
                requestId: "manager-spawn",
                template,
              });
              fs.writeFileSync(`${scratch}/outside-box`, "unchanged", {
                mode: 0o600,
              });
              fs.symlinkSync(
                `${scratch}/outside-box`,
                `${scratch}/boxes/manager-source/work/escape`
              );
              yield* makeManagerOwned("manager-source");
              yield* act("manager-source", "clone", {
                newPeonId: "manager-copy",
              });
              assert.ok((yield* inspect("manager-copy")).bytes.home > 0);
              yield* assertRecovered("manager-source");
              yield* assertRecovered("manager-copy");
              yield* makeManagerOwned("manager-copy");
              yield* exportBox("manager-copy");
              yield* act("manager-copy", "destroy");
              yield* makeManagerOwned("manager-source");
              yield* act("manager-source", "hibernate");
              assert.ok((yield* inspect("manager-source")).bytes.snapshot > 0);
              yield* exportBox("manager-source");
              yield* act("manager-source", "destroy");
              assert.equal(
                fs.statSync(`${scratch}/outside-box`).mode % 0o1000,
                0o600
              );
              yield* Effect.log(
                "PASS manager-owned 700 recovery: clone, delete, snapshot/hibernate; external symlink target untouched"
              );

              const seedHistory = (id: string) =>
                checked("docker", [
                  "exec",
                  physical(id),
                  "/bin/sh",
                  "-eu",
                  "-c",
                  "mkdir -p /home/peon/.codex; printf 'fixture transcript\\n' > /home/peon/.codex/history.jsonl",
                ]);

              const proofBox = Effect.fn("Manual.proofBox")(function* proofBox(
                id: string
              ) {
                step = `${id} spawn clean Git checkout`;
                yield* boxes.create({
                  peonId: id,
                  requestId: "spawn",
                  template,
                });
                seedHistory(id);
              });

              const destroyLanded = (id: string) =>
                act(id, "destroy", { landedHead: sha });

              const verifiedDestroy = Effect.fn("Manual.verifiedDestroy")(
                function* verifiedDestroy(id: string) {
                  const result = yield* Schema.decodeUnknownEffect(Result)(
                    yield* destroyLanded(id)
                  );

                  assert.equal(result.exportReceipt?.replicaState, "verified");
                  assert.equal((yield* inspect(id)).state, "destroyed");

                  return result;
                }
              );

              const live = "landed-live";
              yield* proofBox(live);
              const receipt = yield* exportBox(live, false);
              assert.equal(
                (yield* Effect.flip(destroyLanded(live)))._tag,
                "ReplicaPending"
              );
              yield* Effect.log(
                "PASS destroy refuses before rsync: ReplicaPending"
              );
              checked("rsync", ["-a", "--", `${primary}/${live}`, replica]);

              const replicaHistory = path.join(
                path.dirname(receipt.mirror),
                ".codex/history.jsonl"
              );

              const transcript = fs.readFileSync(replicaHistory, "utf-8");
              assert.equal(transcript, "fixture transcript\n");
              fs.writeFileSync(replicaHistory, `F${transcript.slice(1)}`);
              assert.equal(
                (yield* Effect.flip(destroyLanded(live)))._tag,
                "ReplicaMismatch"
              );
              fs.writeFileSync(replicaHistory, transcript);
              yield* Effect.log(
                "PASS destroy refuses a one-byte replica change: ReplicaMismatch"
              );

              const editWork = Effect.fn("Manual.editWork")(function* editWork(
                script: string
              ) {
                const result = yield* runner.run({
                  executable: "docker",
                  args: [
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
                    `65534:${gid}`,
                    "--mount",
                    `type=bind,source=${scratch}/boxes/${live}/work,target=/work`,
                    "--workdir",
                    "/work",
                    "--entrypoint",
                    "/bin/sh",
                    pinned,
                    "-eu",
                    "-c",
                    `export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid\n${script}`,
                  ],
                });

                assert.equal(result.exit, 0, result.stderr);
              });

              for (const fixture of [
                {
                  name: "untracked",
                  plant: ": > stray.txt",
                  clear: "unlink stray.txt",
                  path: "stray.txt",
                },
                {
                  name: "assume-unchanged",
                  plant:
                    'git update-index --assume-unchanged proof.txt; printf changed > proof.txt; test -z "$(git status --porcelain)"',
                  clear:
                    "git update-index --no-assume-unchanged proof.txt; git restore -- proof.txt",
                  path: "proof.txt",
                },
                {
                  name: "unmerged branch",
                  plant:
                    'git branch unlanded "$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m unlanded)"',
                  clear: "git branch -D unlanded",
                  ref: "refs/heads/unlanded",
                },
                {
                  name: "stash",
                  plant:
                    "printf stashed > proof.txt; git stash push; git stash list | grep -q .",
                  clear: "git stash drop",
                  ref: "stash@{0}",
                },
                {
                  name: "stash FIFO",
                  plant: "mkdir -p .git/logs/refs; mkfifo .git/logs/refs/stash",
                  clear: "unlink .git/logs/refs/stash",
                  reason:
                    /Git refs, reflogs and other metadata must be canonical regular files/u,
                },
              ]) {
                step = `landed workspace refusal: ${fixture.name}`;
                yield* editWork(fixture.plant);

                const blocked = yield* Effect.flip(
                  fixture.name === "stash FIFO"
                    ? destroyLanded(live).pipe(Effect.timeout("15 seconds"))
                    : destroyLanded(live)
                );

                assert.equal(blocked._tag, "WorkspaceUnlanded");

                if (fixture.reason !== undefined) {
                  assert.match(blocked.message, fixture.reason);
                }

                if (fixture.path !== undefined) {
                  assert.ok(
                    blocked.dirtyPaths.includes(fixture.path),
                    blocked.message
                  );
                }

                if (fixture.ref !== undefined) {
                  assert.ok(
                    blocked.refs.includes(fixture.ref),
                    blocked.message
                  );
                }

                yield* editWork(fixture.clear);
                yield* Effect.log(`PASS WorkspaceUnlanded: ${fixture.name}`);
              }

              yield* verifiedDestroy(live);
              yield* Effect.log(
                "PASS clean live landedHead and rsync replica verified; destroyed"
              );

              const sleeping = "landed-sleeping";
              yield* proofBox(sleeping);
              yield* act(sleeping, "hibernate");
              assert.equal((yield* inspect(sleeping)).state, "hibernated");
              yield* exportBox(sleeping);
              yield* verifiedDestroy(sleeping);
              yield* Effect.log(
                "PASS hibernated landedHead proof reads extracted Git objects; destroyed"
              );

              const resumed = "landed-resumed";
              yield* proofBox(resumed);
              yield* act(resumed, "hibernate");
              yield* act(resumed, "resume");
              checked("docker", [
                "exec",
                physical(resumed),
                "unlink",
                "/home/peon/.codex/history.jsonl",
              ]);
              const resumedReceipt = yield* exportBox(resumed);

              for (const copy of [
                resumedReceipt.location,
                resumedReceipt.mirror,
              ]) {
                const archive = path.dirname(copy);
                assert.ok(
                  !fs.existsSync(path.join(archive, ".codex/history.jsonl"))
                );
                assert.equal(
                  fs.readFileSync(
                    path.join(archive, "snapshot/.codex/history.jsonl"),
                    "utf-8"
                  ),
                  transcript
                );
              }

              const final = yield* verifiedDestroy(resumed);
              assert.equal(final.snapshotWorkSuperseded, true);
              yield* Effect.log(
                "PASS deleted live transcript preserved under snapshot/ in both verified copies"
              );
            }).pipe(
              Effect.provide(
                Boxes.layer(config).pipe(
                  Layer.provide(
                    archiveDiskLayer(
                      {
                        checkerHost: hostname().split(".")[0] ?? "",
                        primary,
                        replica,
                      },
                      () => Effect.void
                    )
                  ),
                  Layer.provide(
                    Layer.mergeAll(
                      NodeServices.layer,
                      Digest.layerWebCrypto,
                      Layer.succeed(Runner, runner)
                    )
                  )
                )
              )
            );
          }).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.isFailure(exit)) {
                  process.stderr.write(
                    `PRIMARY FAILURE at ${step}\n${Cause.pretty(exit.cause)}\n`
                  );
                }

                const cleanupErrors: string[] = [];

                for (const name of names) {
                  try {
                    removeOwned(name);
                  } catch (error) {
                    cleanupErrors.push(`${name}: ${String(error)}`);
                  }
                }

                try {
                  const boxes = path.join(scratch, "boxes");

                  if (fs.existsSync(boxes)) {
                    fs.chmodSync(boxes, 0o770);
                    const cleanup = `${prefix}cleanup`;

                    try {
                      checked("docker", [
                        "run",
                        "--rm",
                        "--name",
                        cleanup,
                        "--label",
                        label,
                        "--pull",
                        "never",
                        "--network",
                        "none",
                        "--read-only",
                        "--cap-drop",
                        "ALL",
                        "--security-opt",
                        "no-new-privileges",
                        "--cap-add",
                        "DAC_OVERRIDE",
                        "--user",
                        `0:${gid}`,
                        "--mount",
                        `type=bind,source=${boxes},target=/boxes`,
                        "--entrypoint",
                        "node",
                        imageId,
                        "-e",
                        "const fs=require('node:fs');for(const name of fs.readdirSync('/boxes'))fs.rmSync('/boxes/'+name,{recursive:true})",
                      ]);
                    } finally {
                      removeOwned(cleanup);
                    }
                  }

                  for (const name of fs.readdirSync(scratch)) {
                    fs.rmSync(path.join(scratch, name), { recursive: true });
                  }

                  fs.rmdirSync(scratch);
                } catch (error) {
                  cleanupErrors.push(`${scratch}: ${String(error)}`);
                }

                if (cleanupErrors.length === 0) {
                  process.stdout.write(
                    `CLEANED owned containers and scratch; label ${label}\n`
                  );
                } else {
                  const message = `CLEANUP FAILED (${label}): ${cleanupErrors.join("; ")}`;
                  process.stderr.write(`${message}\n`);

                  if (Exit.isSuccess(exit)) {
                    assert.fail(message);
                  }
                }
              })
            )
          );
        }),
      { timeout: 360_000 }
    );
  }
);
