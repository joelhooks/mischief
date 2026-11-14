import assert from "node:assert/strict";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The manual Docker harness runs synchronous host commands outside the product runtime.
import { spawnSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The manual harness validates and creates its scratch directory before acquiring services.
import * as fs from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Scratch validation must finish before the manual harness starts Docker.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import * as Digest from "effect/crypto/Digest";

import { Boxes } from "../dist/box/manager.js";
import { PromptResult } from "../dist/box/protocol.js";
import type { Action, BoxTemplate } from "../dist/box/protocol.js";
import { Runner } from "../dist/runner.js";

const [scratch, image, prefix] = process.argv.slice(2);

const checkout = fs.realpathSync(path.resolve(import.meta.dirname, "../../.."));

assert.ok(scratch !== undefined && path.isAbsolute(scratch));

assert.ok(
  (scratch.startsWith(`${checkout}/`) ||
    scratch.startsWith("/data/joel/scratch/peonlife/")) &&
    path.normalize(scratch) === scratch
);

assert.ok(!scratch.includes("/srv/mischief-peons"));

assert.equal(fs.realpathSync(path.dirname(scratch)), path.dirname(scratch));

assert.ok(
  !fs.existsSync(scratch),
  "Scratch must be a new directory owned by this run"
);

assert.equal(image, "mischief-peon-full:ab95d63");

assert.ok(prefix !== undefined && /^mpt-[a-z0-9-]+$/u.test(prefix));

const names = new Set<string>();

let helper = 0;

let step = "setup";

const command = (
  executable: string,
  args: readonly string[],
  input?: string
) => {
  const output = spawnSync(executable, args, { encoding: "utf-8", input });
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

const imageId = checked("docker", [
  "image",
  "inspect",
  image,
  "--format",
  "{{.Id}}",
]);

assert.match(imageId, /^sha256:[0-9a-f]{64}$/u);

const pinned = `mischief-peon-full@${imageId}`;

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
        return command(request.executable, request.args, request.input);
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
        }

        if (arg === 'umask 0007; exec pi "$@"') {
          arg = 'umask 0007; exec /home/peon/fake-pi "$@"';
        }

        args.push(arg);
      }

      if (args[0] === "create") {
        const name = args[args.indexOf("--name") + 1] ?? "";
        assert.ok(name.startsWith("mpt-"));
      }

      if (args[0] === "run") {
        const name = `${prefix}helper-${nextKey()}`;
        args.splice(1, 0, "--name", name);
      }

      const result = command("docker", args, request.input);

      if (result.exit === 0 && (args[0] === "create" || args[0] === "run")) {
        names.add(args[args.indexOf("--name") + 1] ?? "");
      }

      return result;
    }),
});

const fakePi = `#!/bin/sh
set -eu
cache=0
if [ -s /home/peon/session.jsonl ]; then cache=17; fi
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

try {
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

  await Effect.runPromise(
    Effect.gen(function* lifecycle() {
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
        extra: { text?: string; newPeonId?: string } = {}
      ) => {
        step = `${id} ${action}`;

        return boxes.act({
          peonId: id,
          action,
          requestId: `${id}-${action}-${nextKey()}`,
          ...extra,
        });
      };

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
      yield* boxes.create({ peonId: "source", requestId: "spawn", template });
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
      yield* act("source", "prompt", { text: "remember this conversation" });
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
          yield* Effect.log("PASS suspend: Running=false Pid=0 processes=0");
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
        yield* act(id, "destroy");
        yield* Effect.log(`PASS delete recovers partial ownership for ${id}`);
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
      yield* act("source", "destroy");
      assert.equal((yield* inspect("source")).state, "destroyed");
      yield* Effect.log("PASS delete; no model calls made");
      step = "manager-source spawn";
      yield* boxes.create({
        peonId: "manager-source",
        requestId: "manager-spawn",
        template,
      });
      fs.writeFileSync(`${scratch}/outside-box`, "unchanged", { mode: 0o600 });
      fs.symlinkSync(
        `${scratch}/outside-box`,
        `${scratch}/boxes/manager-source/work/escape`
      );
      yield* makeManagerOwned("manager-source");
      yield* act("manager-source", "clone", { newPeonId: "manager-copy" });
      assert.ok((yield* inspect("manager-copy")).bytes.home > 0);
      yield* assertRecovered("manager-source");
      yield* assertRecovered("manager-copy");
      yield* makeManagerOwned("manager-copy");
      yield* act("manager-copy", "destroy");
      yield* makeManagerOwned("manager-source");
      yield* act("manager-source", "hibernate");
      assert.ok((yield* inspect("manager-source")).bytes.snapshot > 0);
      yield* act("manager-source", "destroy");
      assert.equal(fs.statSync(`${scratch}/outside-box`).mode % 0o1000, 0o600);
      yield* Effect.log(
        "PASS manager-owned 700 recovery: clone, delete, snapshot/hibernate; external symlink target untouched"
      );
    }).pipe(
      Effect.provide(
        Boxes.layer(config).pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Digest.layerWebCrypto,
              Layer.succeed(Runner, runner)
            )
          )
        )
      )
    )
  );
} catch (error) {
  process.stderr.write(
    `PRIMARY FAILURE at ${step}\n${error instanceof Error ? (error.stack ?? String(error)) : String(error)}\n`
  );
  throw error;
} finally {
  for (const name of names) {
    try {
      assert.ok(name.startsWith(prefix) && name.startsWith("mpt-"));
      const removed = command("docker", ["rm", "--force", name]);
      assert.ok(
        removed.exit === 0 || removed.stderr.includes("No such container"),
        removed.stderr
      );
    } catch (error) {
      process.stderr.write(`CLEANUP WARNING ${name}: ${String(error)}\n`);
    }
  }

  try {
    const boxes = path.join(scratch, "boxes");

    if (fs.existsSync(boxes)) {
      fs.chmodSync(boxes, 0o770);
      checked("docker", [
        "run",
        "--rm",
        "--name",
        `${prefix}cleanup`,
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
        `type=bind,source=${boxes},target=/boxes`,
        "--entrypoint",
        "node",
        imageId,
        "-e",
        "const fs=require('node:fs');for(const name of fs.readdirSync('/boxes'))fs.rmSync('/boxes/'+name,{recursive:true})",
      ]);
    }

    for (const name of fs.readdirSync(scratch)) {
      fs.rmSync(path.join(scratch, name), { recursive: true });
    }

    process.stdout.write(
      `CLEANED owned mpt- containers; empty scratch retained at ${scratch}\n`
    );
  } catch (error) {
    process.stderr.write(
      `CLEANUP WARNING at ${scratch}: ${String(error)}\nSCRATCH RETAINED ${scratch}\n`
    );
  }
}
