import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Predicate,
  Ref,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import * as Digest from "effect/crypto/Digest";
import { TestClock } from "effect/testing";

import { archiveDiskLayer } from "../src/box/archive-disk.js";
import { agentDirs, isArchivePath, sha256 } from "../src/box/archive-source.js";
import {
  ArchivePort,
  ManifestSchema,
  ReadBackResult,
} from "../src/box/archive.js";
import { nextState } from "../src/box/machine.js";
import { Boxes } from "../src/box/manager.js";
import { PromptResult, Snapshot, State } from "../src/box/protocol.js";
import type { BoxTemplate } from "../src/box/protocol.js";
import { receiptKey } from "../src/box/receipt.js";
import { boxRunnerLayer } from "../src/box/runner.js";
import { checked, Runner } from "../src/runner.js";
import { image, piOutput, sha } from "./fixtures.js";

const piHeader =
  '{"type":"session","version":3,"id":"f4f15679-4146-4f95-8917-09c60abe812b","timestamp":"2026-01-01T00:00:00Z","cwd":"/work"}';

const template: BoxTemplate = {
  limits: { cpus: 2, memory: "4g", pids: 512, tmp: "384m" },
  model: "sol",
  system: "Warm system",
  thinking: "medium",
  tools: "all",
  warm: {
    contract: "Warm contract",
    docs: [{ path: "docs/guide.md", text: "Warm guide" }],
  },
  workspace: { repo: "example/review", sha },
};

const harness = Effect.gen(function* harness() {
  const fs = yield* FileSystem.FileSystem;

  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({
      prefix: "mischief-box-test-",
    })
  );

  yield* fs.makeDirectory(`${root}/bin`);
  yield* fs.makeDirectory(`${root}/fake`);

  const script = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> '${root}/commands'
command="$1"; shift
case "$command" in
run)
  if printf '%s' "$*" | grep -q -- '--entrypoint /usr/bin/env .*GIT_DIR=/proof/repo'; then
    objects=''
    for arg in "$@"; do
      case "$arg" in
        type=bind,source=*,target=/proof,readonly)
          proof="\${arg#type=bind,source=}"
          proof="\${proof%,target=/proof,readonly}";;
        type=bind,source=*,target=/objects,readonly)
          storage="\${arg#type=bind,source=}"
          storage="\${storage%,target=/objects,readonly}";;
        GIT_OBJECT_DIRECTORY=/objects) objects="$storage";;
      esac
    done
    until [ "$1" = /usr/bin/git ] || [ "$1" = /bin/sh ]; do
      if [ "$1" = --user ]; then test "$2" = "$(id -u):1000"; fi
      shift
    done
    if [ -n "$objects" ]; then export GIT_OBJECT_DIRECTORY="$objects"; fi
    export GIT_DIR="$proof/repo" GIT_WORK_TREE="$proof/ignore"
    export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1
    if [ "$1" = /bin/sh ]; then exec "$@"; fi
    shift
    exec git -C "$proof/ignore" "$@"
  fi
  if [ -f '${root}/helper-error' ]; then cat '${root}/helper-error' >&2; exit 1; fi
  previous=''
  box=''
  for arg in "$@"; do
    if [ "$previous" = --user ]; then user="$arg"; fi
    case "$arg" in type=bind,source=*,target=/box) box="\${arg#type=bind,source=}"; box="\${box%,target=/box}";; esac
    previous="$arg"
  done
  test -n "$box"
  if [ "$user" = 0:1000 ] && printf '%s' "$*" | grep -q -- '--entrypoint /usr/bin/find'; then
    test "$*" = "--rm --network none --read-only --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges --user 0:1000 --env LC_ALL=C --mount type=bind,source=$box,target=/box --entrypoint /usr/bin/find ${image} /box -xdev -depth ( -user 0 -o -user $(id -u) ) -exec /bin/chown -h 65534:1000 {} +"
    if [ -f '${root}/recovery-error' ]; then cat '${root}/recovery-error' >&2; exit 1; fi
    if [ -f '${root}/manager-owned' ]; then
      if find "$box" -type d ! -perm 0770 | grep -q .; then printf 'chown: manager-owned tree is not group traversable\\n' >&2; exit 1; fi
      unlink '${root}/manager-owned'
    fi
    if [ -f '${root}/partial-root-owned' ]; then unlink '${root}/partial-root-owned'; fi
    if find "$box" -type d ! -perm 0770 | grep -q .; then
      printf "/usr/bin/find: '/box/home/.claude/projects': Permission denied\\n" >&2
      exit 1
    fi
    exit 0
  fi
  if [ "$user" = 65534:1000 ]; then
    test ! -f '${root}/partial-root-owned'
    test ! -f '${root}/manager-owned'
    test "$*" = "--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:1000 --mount type=bind,source=$box,target=/box --entrypoint /bin/chmod ${image} -R u+rwX,g+rwX,o-rwx /box"
    chmod -R u+rwX,g+rwX,o-rwx "$box"
    exit 0
  fi
  test "$user" = 0:1000
  if find "$box" -type d ! -perm 0770 | grep -q .; then
    printf 'partial ownership transfer\\n' > '${root}/partial-root-owned'
    printf 'group cannot traverse box directories\\n' >&2
    exit 1
  fi
  exit 0;;
create)
  test "$1" = --name
  name="$2"
  printf stopped > '${root}/fake/'"$name"
  printf '%s\n' "$@" > '${root}/fake/'"$name"'.args'
  ;;
start) printf running > '${root}/fake/'"$1";;
stop) if [ ! -f '${root}/stop-stuck' ]; then printf stopped > '${root}/fake/'"$1"; fi;;
rm) for name in "$@"; do case "$name" in mischief-peon-box-*) unlink '${root}/fake/'"$name";; esac; done;;
inspect)
  shift; shift
  if grep -qx running '${root}/fake/'"$1"; then printf '{"Running":true,"Pid":123}'; else printf '{"Running":false,"Pid":0}'; fi;;
ps)
  for file in '${root}/fake/'*; do
    name="\${file##*/}"
    if [ "$2" = --filter ] && [ "$3" = "name=^/$name$" ]; then printf '%s\\n' "$name"; fi
  done;;
top) printf 'PID\\n123\\n';;
exec)
  while [ "\${1#mischief-peon-box-}" = "$1" ]; do shift; done
  id="\${1#mischief-peon-box-}"; shift
  if [ "$1" = /bin/sh ]; then
    boxenv='${root}/fake/mischief-peon-box-'"$id"'.args'
    base='${root}/boxes/'"$id"'/home'
    for key in PI_CODING_AGENT_DIR CLAUDE_CONFIG_DIR CODEX_HOME; do
      value="$(grep "^$key=/home/peon/" "$boxenv" | cut -d/ -f4-)"
      export "$key=$base/$value"
    done
    PEON_TEST_ID="$id" "$@"
  else
    umask 0007
    mkdir -p '${root}/boxes/'"$id"'/home/.box/requests'
    for arg in "$@"; do case "$arg" in /home/peon/.box/requests/*) file="\${arg##*/}";; esac; done
    cat > '${root}/boxes/'"$id"'/home/.box/requests/'"$file"
  fi;;
*) exit 91;;
esac
`;

  yield* fs.writeFileString(`${root}/bin/docker`, script, { mode: 0o700 });
  yield* fs.writeFileString(
    `${root}/bin/env`,
    `#!/bin/sh
set -eu
if [ "$1" = LC_ALL=C ] && [ "$2" = find ]; then
  shift; shift
  box="$1"
  test "$*" = "$box -xdev -user $(id -u) ! -type l -exec chmod u+rwX,g+rwX,o-rwx {} +"
  printf 'host-find %s\\n' "$*" >> '${root}/commands'
  if [ -f '${root}/manager-error' ]; then cat '${root}/manager-error' >&2; exit 1; fi
  if [ -f '${root}/manager-owned' ]; then exec /usr/bin/find "$@"; fi
  printf "find: '$box/home/.claude/projects': Permission denied\\n" >&2
  exit 1
fi
exec /usr/bin/env "$@"
`,
    { mode: 0o700 }
  );
  yield* fs.writeFileString(
    `${root}/bin/du`,
    `#!/bin/sh
set -eu
if find "$2" -type d ! -perm 0770 | grep -q .; then
  printf 'size cannot traverse private directories before owner regrant\\n' >&2
  exit 1
fi
exec /usr/bin/du "$@"
`,
    { mode: 0o700 }
  );
  yield* fs.writeFileString(
    `${root}/bin/pi`,
    `#!/bin/sh
set -eu
id="$PEON_TEST_ID"
input="$(cat)"
session='${root}/boxes/'"$id"'/home/session.jsonl'
if [ ! -f "$session" ]; then printf '%s\\n' '${piHeader}' > "$session"; fi
printf '%s\\n' "$input" >> "$session"
mkdir -p '${root}/boxes/'"$id"'/home/tool/nested'
for directory in .claude/projects .claude/sessions .claude/plugins .pi/agent/claude-bridge; do
  mkdir -p '${root}/boxes/'"$id"'/home/'"$directory"
  chmod 700 '${root}/boxes/'"$id"'/home/'"$directory"
done
mkdir -p "$PI_CODING_AGENT_DIR/sessions" "$CODEX_HOME/sessions" "$CODEX_HOME/archived_sessions"
printf '%s\\n' '${piHeader}' > "$PI_CODING_AGENT_DIR/sessions/fixture.jsonl"
printf '%s\\n' '{"sessionId":"8bef6a17-e343-4849-9858-aa31eafe62af"}' > "$CLAUDE_CONFIG_DIR/projects/fixture.jsonl"
printf '%s\\n' '{}' > "$PI_CODING_AGENT_DIR/claude-bridge/state.json"
printf '%s\\n' '{"type":"session_meta","payload":{"id":"b4419e3f-b704-4d1a-a45b-161a1695ae9c"}}' > "$CODEX_HOME/sessions/fixture.jsonl"
cp "$CODEX_HOME/sessions/fixture.jsonl" "$CODEX_HOME/archived_sessions/fixture.jsonl"
printf '%s\\n' '{}' > "$CODEX_HOME/history.jsonl"
printf 'changed by tool\\n' > '${root}/boxes/'"$id"'/work/result.txt'
printf '%s\\n' '${piOutput}'
`,
    { mode: 0o700 }
  );
  const source = `${root}/source`;
  yield* checked({ args: ["init", source], executable: "git" });
  yield* fs.writeFileString(`${source}/proof.txt`, "pinned contents\n");
  yield* fs.writeFileString(`${source}/.gitignore`, "build/\n");
  yield* checked({
    args: ["-C", source, "add", ".gitignore", "proof.txt"],
    executable: "git",
  });
  yield* checked({
    args: [
      "-C",
      source,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    executable: "git",
  });

  const pinned = (yield* checked({
    args: ["-C", source, "rev-parse", "HEAD"],
    executable: "git",
  })).trim();

  const runner = yield* Runner.pipe(
    Effect.provide(boxRunnerLayer(`${root}/bin:/usr/bin:/bin`))
  );

  return {
    config: {
      gid: 1000,
      image,
      metadata: `${root}/metadata`,
      mount: root,
      mirrors: { "example/review": source },
      root: `${root}/boxes`,
      snapshots: `${root}/snapshots`,
    },
    root,
    runner,
    template: {
      ...template,
      workspace: { ...template.workspace, sha: pinned },
    },
  };
});

const custodyFixture = Effect.gen(function* custodyFixture() {
  const fixture = yield* harness;
  const fs = yield* FileSystem.FileSystem;

  const roots = {
    replica: `${fixture.root}/replica-custody`,
    primary: `${fixture.root}/primary-custody`,
  };

  yield* fs.makeDirectory(roots.primary);
  yield* fs.makeDirectory(roots.replica);
  const alias = `${fixture.root}/primary-alias`;
  yield* fs.symlink(roots.primary, alias);

  return {
    ...fixture,
    disk: archiveDiskLayer(
      { ...roots, checkerHost: "test-host", primary: alias },
      () => Effect.void
    ).pipe(Layer.provide(Layer.succeed(Runner, fixture.runner))),
    roots,
    replicate: (id: string) =>
      Effect.gen(function* replicate() {
        yield* fs.makeDirectory(`${roots.replica}/${id.split("/")[0]}`, {
          recursive: true,
        });
        yield* checked({
          executable: "cp",
          args: [
            "-a",
            "--",
            `${roots.primary}/${id}`,
            `${roots.replica}/${id}`,
          ],
        });
      }),
  };
});

const Export = Schema.Struct({
  exportReceipt: Schema.Struct({
    id: Schema.String,
    location: Schema.String,
    mirror: Schema.String,
    replicaState: Schema.Literals(["pending", "verified"]),
    sha256: Schema.String,
  }),
});

it.effect(
  "destroy requires two verified custody copies of the current stopped session set",
  () =>
    Effect.gen(function* dualCustody() {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* custodyFixture;

      const boxLayer = Boxes.layer(fixture.config).pipe(
        Layer.provide(fixture.disk)
      );

      yield* Effect.gen(function* actAndVerify() {
        const boxes = yield* Boxes;
        const peonId = "custody";
        const home = `${fixture.root}/boxes/${peonId}/home`;
        const managed = `${home}/session.jsonl`;
        yield* boxes.create({
          peonId,
          requestId: "create",
          template: fixture.template,
        });

        const filesInHome = checked({
          executable: "find",
          args: [home, "-type", "f", "-printf", "%P\\n"],
        }).pipe(Effect.map((files) => files.split("\n").filter(Boolean)));

        const before = new Set(yield* filesInHome);
        yield* boxes.act({
          action: "prompt",
          peonId,
          requestId: "turn",
          text: "synthetic turn 🐀",
        });

        const written = (yield* filesInHome).filter(
          (name) =>
            !before.has(name) &&
            (name === "session.jsonl" ||
              Object.values(agentDirs).some((dir) =>
                name.startsWith(`${dir}/`)
              ))
        );

        expect(written).toHaveLength(7);
        expect(written.filter((name) => !isArchivePath(name))).toEqual([]);
        expect(
          (yield* Effect.flip(
            boxes.act({ action: "destroy", peonId, requestId: "early-delete" })
          )).message
        ).toContain("no matching verified receipt");
        yield* fs.remove(managed);
        expect(
          (yield* Effect.flip(
            boxes.act({
              action: "export",
              peonId,
              requestId: "missing-session",
            })
          )).message
        ).toContain("missing its managed Pi session");
        expect(yield* fs.readDirectory(fixture.roots.primary)).toEqual([]);
        const original = `${piHeader}\nsynthetic turn 🐀\n`;
        yield* fs.writeFileString(managed, original);
        yield* fs.makeDirectory(`${home}/.codex/sessions/2026`, {
          mode: 0o770,
          recursive: true,
        });
        yield* fs.writeFileString(
          `${home}/.codex/sessions/2026/rollout.jsonl`,
          '{"event":"fixture"}\n'
        );
        yield* fs.link(managed, `${home}/.codex/sessions/raw transcript.jsonl`);
        yield* checked({
          executable: "mkfifo",
          args: [`${home}/.codex/sessions/pipe`],
        });
        const target = `${fixture.root}/not-a-session`;
        yield* fs.writeFileString(target, "must not be copied\n");
        yield* fs.symlink(target, `${home}/.codex/sessions/never-follow`);

        const unavailable = `${fixture.roots.primary}-offline`;
        yield* fs.rename(fixture.roots.primary, unavailable);

        const offline = yield* Effect.flip(
          boxes.act({ action: "export", peonId })
        );

        expect(offline._tag).toBe("CustodyMissing");
        yield* fs.rename(unavailable, fixture.roots.primary);

        const exported = yield* Schema.decodeUnknownEffect(Export)(
          yield* boxes.act({
            action: "export",
            peonId,
            requestId: "first-export",
          })
        );

        const proof = exported.exportReceipt;
        expect(
          yield* boxes.act({
            action: "export",
            peonId,
            requestId: "retry-export",
          })
        ).toMatchObject(exported);
        expect(
          yield* fs.readDirectory(`${fixture.roots.primary}/${peonId}`)
        ).toEqual([proof.id.split("/")[1]]);

        expect(proof.replicaState).toBe("pending");
        expect(yield* fs.readDirectory(fixture.roots.replica)).toEqual([]);

        const pending = yield* Effect.flip(
          boxes.act({
            action: "destroy",
            peonId,
            requestId: "pending",
            discardWorkspace: true,
          })
        );

        expect(pending._tag).toBe("ReplicaPending");
        expect(
          Predicate.isTagged(pending, "ReplicaPending") && pending.archiveId
        ).toBe(proof.id);
        yield* fixture.replicate(proof.id);

        for (const root of Object.values(fixture.roots)) {
          const dest = `${root}/${proof.id}`;
          expect(yield* fs.readFileString(`${dest}/session.jsonl`)).toBe(
            original
          );
          expect(
            yield* fs.readFileString(
              `${dest}/.codex/sessions/2026/rollout.jsonl`
            )
          ).toBe('{"event":"fixture"}\n');
          expect(yield* fs.exists(`${dest}/.codex/sessions/never-follow`)).toBe(
            false
          );
          expect(yield* fs.readFileString(`${dest}/SYMLINKS.tsv`)).toBe(
            `.codex/sessions/never-follow\t${target}\n`
          );

          const manifestText = yield* fs.readFileString(
            `${dest}/manifest.json`
          );

          const manifest = yield* Schema.decodeEffect(
            Schema.fromJsonString(ManifestSchema)
          )(manifestText);

          const checksums = yield* fs.readFileString(`${dest}/MANIFEST.sha256`);

          const listed = checksums
            .trimEnd()
            .split("\n")
            .map((line) => line.slice(66))
            .toSorted();

          const renamed = manifest.renamed ?? [];
          expect(renamed.map(({ from }) => from)).toEqual([
            ".codex/sessions/raw transcript.jsonl",
          ]);
          expect(new Set(renamed.map(({ from }) => from)).size).toBe(
            renamed.length
          );
          expect(renamed.every(({ to }) => listed.includes(to))).toBe(true);

          for (const { to } of renamed) {
            expect(yield* fs.readFileString(`${dest}/${to}`)).toBe(original);
          }

          expect(manifest.nonData).toEqual([
            { path: ".codex/sessions/pipe", type: "FIFO" },
          ]);
          expect(listed).toEqual(
            [
              ...written,
              ".codex/sessions/2026/rollout.jsonl",
              ...renamed.map(({ to }) => to),
            ].toSorted()
          );
          expect(yield* fs.exists(`${dest}/.codex/sessions/pipe`)).toBe(false);
          let bytes = 0;

          for (const name of listed) {
            bytes += Number((yield* fs.stat(`${dest}/${name}`)).size);
          }

          expect(manifest.files).toBe(listed.length);
          expect(manifest.bytes).toBe(bytes);
          const receiptText = yield* fs.readFileString(`${dest}/RECEIPT.json`);
          expect(receiptText).toContain(
            `"manifest_sha256":"${sha256(checksums)}"`
          );
          expect(receiptText).toContain(
            `"manifest_json_sha256":"${sha256(manifestText)}"`
          );
          expect(receiptText).toContain('"sessions":3');
          expect(receiptText).toContain('"unparsed":2');
          expect(receiptText).toContain('"skipped":0');
        }

        yield* fs.rename(`${home}/.pi/agent`, `${home}/.pi/agent-held`);
        expect(
          (yield* Effect.flip(
            boxes.act({
              action: "destroy",
              peonId,
              requestId: "missing-agent-directory",
            })
          )).message
        ).toContain("Pi agent directory is missing");
        yield* fs.rename(`${home}/.pi/agent-held`, `${home}/.pi/agent`);
        yield* fs.writeFileString(managed, `${original}new raw bytes\n`);
        expect(
          (yield* Effect.flip(
            boxes.act({
              action: "destroy",
              peonId,
              requestId: "changed-source",
            })
          )).message
        ).toContain("Session inventory changed");
        yield* fs.writeFileString(managed, original);
        const mirrorFile = `${fixture.roots.replica}/${proof.id}/session.jsonl`;
        yield* fs.writeFileString(
          mirrorFile,
          original.replace("synthetic", "different")
        );
        expect(
          (yield* Effect.flip(
            boxes.act({
              action: "destroy",
              peonId,
              requestId: "changed-mirror",
            })
          )).message
        ).toContain("sha256sum verification failed");
        expect(yield* fs.readFileString(managed)).toBe(original);
        yield* fs.writeFileString(mirrorFile, original);
        const mirrorManifest = `${fixture.roots.replica}/${proof.id}/manifest.json`;
        const recordedManifest = yield* fs.readFileString(mirrorManifest);
        yield* fs.writeFileString(mirrorManifest, `${recordedManifest}\n`);

        const badManifest = yield* Effect.flip(
          boxes.act({
            action: "destroy",
            peonId,
            requestId: "changed-manifest",
          })
        );

        expect(badManifest._tag).toBe("ReplicaMismatch");
        yield* fs.writeFileString(mirrorManifest, recordedManifest);
        const originalProof = yield* fs.readFileString(proof.mirror);
        yield* fs.writeFileString(proof.mirror, `${originalProof}\n`);
        expect(
          (yield* Effect.flip(
            boxes.act({
              action: "destroy",
              peonId,
              requestId: "replica-receipt-drift",
            })
          ))._tag
        ).toBe("ReplicaMismatch");
        yield* fs.remove(proof.mirror);
        expect(
          (yield* Effect.flip(
            boxes.act({
              action: "destroy",
              peonId,
              requestId: "missing-mirror-receipt",
            })
          )).status
        ).toBe(409);
        yield* fs.writeFileString(proof.mirror, originalProof);

        const noDisposition = yield* Effect.flip(
          boxes.act({ action: "destroy", peonId, requestId: "no-disposition" })
        );

        expect(noDisposition._tag).toBe("WorkspaceUnlanded");
        const changedWork = `${fixture.root}/boxes/${peonId}/work/result.txt`;

        const dirty = yield* Effect.flip(
          boxes.act({
            action: "destroy",
            peonId,
            requestId: "dirty",
            landedHead: fixture.template.workspace.sha,
          })
        );

        expect(
          Predicate.isTagged(dirty, "WorkspaceUnlanded") && dirty.dirtyPaths
        ).toEqual(["result.txt"]);
        yield* fs.remove(changedWork);

        const destroyed = yield* boxes.act({
          action: "destroy",
          peonId,
          landedHead: fixture.template.workspace.sha,
          requestId: "verified-delete",
        });

        expect(destroyed).toMatchObject({
          exportReceipt: { ...proof, replicaState: "verified" },
          snapshotKept: false,
          state: "destroyed",
        });
        expect(Number(destroyed.bytesFreed)).toBeGreaterThan(0);
        expect(yield* fs.exists(home)).toBe(false);
      }).pipe(
        Effect.provide(boxLayer),
        Effect.provideService(Runner, fixture.runner)
      );
    }).pipe(
      Effect.provide(
        boxRunnerLayer().pipe(
          Layer.provideMerge(
            Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
          )
        )
      )
    )
);

it.effect(
  "a crash after put leaves an incoming zero-session inventory that cannot authorize destroy",
  () =>
    Effect.gen(function* crashAfterPut() {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* custodyFixture;
      const disk = yield* ArchivePort.pipe(Effect.provide(fixture.disk));

      const crash = Layer.succeed(
        ArchivePort,
        ArchivePort.of({
          open: disk.open.pipe(
            Effect.map((archive) => ({
              ...archive,
              readBack: () => Effect.interrupt,
            }))
          ),
        })
      );

      const peonId = "crash";
      const before = Boxes.layer(fixture.config).pipe(Layer.provide(crash));

      const after = Boxes.layer(fixture.config).pipe(
        Layer.provide(fixture.disk)
      );

      yield* Effect.gen(function* interruptedExport() {
        const boxes = yield* Boxes;
        yield* boxes.create({
          peonId,
          requestId: "create",
          template: fixture.template,
        });

        const attempt = yield* Effect.forkChild(
          boxes.act({ action: "export", peonId, requestId: "cut" })
        );

        expect(Exit.isFailure(yield* Fiber.await(attempt))).toBe(true);
      }).pipe(
        Effect.provide(before),
        Effect.provideService(Runner, fixture.runner)
      );

      const incoming = `${fixture.roots.primary}/${peonId}/.incoming-mischief-peon-box-crash-19700101T000000.000Z`;
      expect(yield* fs.exists(`${incoming}/manifest.json`)).toBe(true);
      expect(yield* fs.exists(`${incoming}/RECEIPT.json`)).toBe(false);
      expect(yield* fs.readDirectory(fixture.roots.replica)).toEqual([]);

      yield* Effect.gen(function* recoveredExport() {
        const boxes = yield* Boxes;
        expect(
          (yield* Effect.flip(
            boxes.act({ action: "destroy", peonId, requestId: "refused" })
          )).status
        ).toBe(409);
        yield* TestClock.adjust(1000);

        const exported = yield* Schema.decodeUnknownEffect(Export)(
          yield* boxes.act({ action: "export", peonId, requestId: "cut" })
        );

        expect(
          yield* fs.readFileString(exported.exportReceipt.location)
        ).toContain('"sessions":0');
        yield* fixture.replicate(exported.exportReceipt.id);
        expect(
          yield* fs.readFileString(exported.exportReceipt.mirror)
        ).toContain('"sessions":0');
        expect(
          yield* boxes.act({
            action: "destroy",
            peonId,
            discardWorkspace: true,
            requestId: "recovered-delete",
          })
        ).toMatchObject({ state: "destroyed" });
      }).pipe(
        Effect.provide(after),
        Effect.provideService(Runner, fixture.runner)
      );
    }).pipe(
      Effect.provide(
        boxRunnerLayer().pipe(
          Layer.provideMerge(
            Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
          )
        )
      )
    )
);

it.effect(
  "a destroy cut after Docker removal resumes from custody and returns the original tombstone",
  () =>
    Effect.gen(function* destroyCut() {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* custodyFixture;
      const peonId = "cut-destroy";
      const atPut = yield* Deferred.make<undefined>();
      const releasePut = yield* Deferred.make<undefined>();
      const disk = yield* ArchivePort.pipe(Effect.provide(fixture.disk));

      const delayed = Layer.succeed(
        ArchivePort,
        ArchivePort.of({
          open: disk.open.pipe(
            Effect.map((archive) => ({
              put: (
                manifest: Parameters<typeof archive.put>[0],
                files: Parameters<typeof archive.put>[1]
              ) =>
                Deferred.succeed(atPut, undefined).pipe(
                  Effect.andThen(Deferred.await(releasePut)),
                  Effect.andThen(archive.put(manifest, files))
                ),
              readBack: archive.readBack,
            }))
          ),
        })
      );

      const cutting = Runner.of({
        run: (command) => {
          const run = fixture.runner.run(command);

          return command.executable === "docker" &&
            command.args[0] === "rm" &&
            command.args[1] === "--force"
            ? run.pipe(Effect.andThen(Effect.interrupt))
            : run;
        },
      });

      const before = Boxes.layer(fixture.config).pipe(Layer.provide(delayed));
      yield* Effect.gen(function* cut() {
        const boxes = yield* Boxes;
        yield* boxes.create({
          peonId,
          template: fixture.template,
          requestId: "create",
        });

        const exporter = yield* Effect.forkChild(
          boxes.act({ action: "export", peonId })
        );

        yield* Deferred.await(atPut);

        const busy = yield* Effect.flip(
          boxes.act({
            action: "destroy",
            peonId,
            requestId: "delete",
            discardWorkspace: true,
          })
        );

        expect(busy.message).toContain("Box is busy");
        yield* Deferred.succeed(releasePut, undefined);

        const exported = yield* Schema.decodeUnknownEffect(Export)(
          yield* Fiber.join(exporter)
        );

        yield* fixture.replicate(exported.exportReceipt.id);

        const deleter = yield* Effect.forkChild(
          boxes.act({
            action: "destroy",
            peonId,
            requestId: "delete",
            discardWorkspace: true,
            row: "test-row",
          })
        );

        expect(Exit.isFailure(yield* Fiber.await(deleter))).toBe(true);
        expect(
          yield* fs.exists(`${fixture.root}/fake/mischief-peon-box-${peonId}`)
        ).toBe(false);
      }).pipe(Effect.provide(before), Effect.provideService(Runner, cutting));
      const meta = `${fixture.root}/metadata/${peonId}`;
      const startupStaging = `${meta}/snapshot-read-startup`;
      yield* fs.makeDirectory(startupStaging);
      yield* Effect.gen(function* resumeDestroy() {
        const boxes = yield* Boxes;

        const exporting = yield* Effect.flip(
          boxes.act({ action: "export", peonId })
        );

        expect(exporting._tag).toBe("DestroyInProgress");
        expect(yield* fs.exists(startupStaging)).toBe(false);
        const teardownStaging = `${meta}/snapshot-read-teardown`;
        yield* fs.makeDirectory(teardownStaging);

        const conflicting = yield* Effect.flip(
          boxes.act({
            action: "destroy",
            peonId,
            requestId: "other",
            landedHead: fixture.template.workspace.sha,
          })
        );

        expect(conflicting._tag).toBe("DestroyInProgress");

        const result = yield* boxes.act({
          action: "destroy",
          peonId,
          requestId: "delete",
          discardWorkspace: true,
        });

        expect(result.state).toBe("destroyed");
        expect(yield* fs.exists(teardownStaging)).toBe(false);
        expect(Number(result.bytesFreed)).toBeGreaterThan(0);
        expect(yield* fs.exists(`${fixture.root}/boxes/${peonId}`)).toBe(false);
        expect(
          yield* boxes.act({ action: "destroy", peonId, requestId: "repeat" })
        ).toEqual(result);
        yield* fs.writeFileString(
          `${fixture.root}/metadata/${peonId}/box.json`,
          JSON.stringify({
            image,
            lastPromptAt: null,
            peonId,
            state: "destroyed",
            template: fixture.template,
          })
        );
        expect(
          yield* boxes.act({
            action: "destroy",
            peonId,
            requestId: "legacy-repeat",
          })
        ).toEqual({ bytesFreed: 0, snapshotKept: false, state: "destroyed" });
      }).pipe(
        Effect.provide(
          Boxes.layer(fixture.config).pipe(Layer.provide(fixture.disk))
        ),
        Effect.provideService(Runner, fixture.runner)
      );
    }).pipe(
      Effect.provide(
        boxRunnerLayer().pipe(
          Layer.provideMerge(
            Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
          )
        )
      )
    )
);

it.effect("hibernated custody preserves a retained snapshot", () =>
  Effect.gen(function* hibernatedCustody() {
    const fs = yield* FileSystem.FileSystem;
    const fixture = yield* custodyFixture;
    const peonId = "retained";
    yield* Effect.gen(function* exportAndRetain() {
      const boxes = yield* Boxes;
      yield* boxes.create({
        peonId,
        template: fixture.template,
        requestId: "create",
      });
      yield* boxes.act({
        action: "prompt",
        peonId,
        requestId: "turn",
        text: "owned fixture",
      });
      yield* fs.remove(`${fixture.root}/boxes/${peonId}/work/result.txt`);

      const snapshot = yield* Schema.decodeUnknownEffect(Snapshot)(
        (yield* boxes.act({ action: "hibernate", peonId, requestId: "park" }))
          .snapshot
      );

      const exported = yield* Schema.decodeUnknownEffect(Export)(
        yield* boxes.act({ action: "export", peonId, row: "tested-row" })
      );

      yield* fixture.replicate(exported.exportReceipt.id);

      const kept = yield* boxes.act({
        action: "hibernate",
        peonId,
        requestId: "mark",
        retained: true,
      });

      expect(kept.snapshot).toMatchObject({ retained: true });

      const cleared = yield* boxes.act({
        action: "hibernate",
        peonId,
        requestId: "clear",
        retained: false,
      });

      expect(cleared.snapshot).not.toHaveProperty("retained");

      const result = yield* boxes.act({
        action: "destroy",
        peonId,
        requestId: "retain",
        retained: true,
        landedHead: fixture.template.workspace.sha,
      });

      expect(result).toMatchObject({
        bytesFreed: 0,
        snapshotKept: true,
        state: "destroyed",
      });
      expect(yield* fs.exists(snapshot.path)).toBe(true);
      const commands = yield* fs.readFileString(`${fixture.root}/commands`);
      expect(
        commands
          .split("\n")
          .filter((line) => line === `start mischief-peon-box-${peonId}`)
      ).toHaveLength(1);
    }).pipe(
      Effect.provide(
        Boxes.layer(fixture.config).pipe(Layer.provide(fixture.disk))
      ),
      Effect.provideService(Runner, fixture.runner)
    );
  }).pipe(
    Effect.provide(
      boxRunnerLayer().pipe(
        Layer.provideMerge(
          Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
        )
      )
    )
  )
);

it.effect(
  "destroy checks landed bytes and refs without using worktree Git settings",
  () =>
    Effect.gen(function* compareWorkspace() {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* custodyFixture;
      yield* Effect.gen(function* workspaceProof() {
        const boxes = yield* Boxes;
        const peonId = "landed-proof";
        const base = `${fixture.root}/boxes/${peonId}`;
        const work = `${base}/work`;
        const landedHead = fixture.template.workspace.sha;

        const git = (...args: string[]) =>
          checked({ executable: "git", args: ["-C", work, ...args] });

        const destroy = (requestId: string) =>
          boxes.act({ action: "destroy", peonId, requestId, landedHead });

        yield* boxes.create({
          peonId,
          template: fixture.template,
          requestId: "create",
        });

        const exported = yield* Schema.decodeUnknownEffect(Export)(
          yield* boxes.act({ action: "export", peonId })
        );

        yield* fixture.replicate(exported.exportReceipt.id);
        yield* git("update-index", "--assume-unchanged", "proof.txt");
        yield* fs.writeFileString(`${work}/proof.txt`, "other contents!\n");
        yield* fs.writeFileString(`${work}/.git/info/exclude`, "new.txt\n");
        yield* fs.writeFileString(`${work}/new.txt`, "unlanded\n");
        yield* fs.makeDirectory(`${work}/build`, { mode: 0o770 });
        yield* fs.writeFileString(`${work}/build/output.txt`, "ignored\n");
        const dirty = yield* Effect.flip(destroy("dirty"));
        expect(
          Predicate.isTagged(dirty, "WorkspaceUnlanded") && dirty.dirtyPaths
        ).toEqual(["new.txt", "proof.txt"]);
        yield* fs.writeFileString(`${work}/proof.txt`, "pinned contents\n");
        yield* fs.chmod(`${work}/proof.txt`, 0o760);
        const modeChange = yield* Effect.flip(destroy("mode"));
        expect(
          Predicate.isTagged(modeChange, "WorkspaceUnlanded") &&
            modeChange.dirtyPaths
        ).toEqual(["new.txt", "proof.txt"]);
        yield* fs.chmod(`${work}/proof.txt`, 0o660);
        yield* fs.remove(`${work}/new.txt`);
        yield* git(
          "-c",
          "user.name=fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "unlanded"
        );
        const abandoned = (yield* git("rev-parse", "HEAD")).trim();
        yield* git("branch", "unlanded", abandoned);
        yield* git("checkout", "--detach", landedHead);
        yield* git("pack-refs", "--all");
        const refs = yield* Effect.flip(destroy("ref"));
        expect(
          Predicate.isTagged(refs, "WorkspaceUnlanded") && refs.refs
        ).toEqual(["refs/heads/unlanded"]);
        yield* git("branch", "-D", "unlanded");

        for (const namespace of ["refs/notes/fixture", "refs/custom/fixture"]) {
          yield* git("update-ref", namespace, abandoned);
          const blocked = yield* Effect.flip(destroy(namespace));
          expect(
            Predicate.isTagged(blocked, "WorkspaceUnlanded") && blocked.refs
          ).toEqual([namespace]);
          yield* git("update-ref", "-d", namespace);
        }

        const linked = `${work}/.git/worktrees/fixture`;
        yield* fs.makeDirectory(linked, { mode: 0o770, recursive: true });
        yield* fs.writeFileString(`${linked}/HEAD`, `${abandoned}\n`);
        const linkedRefusal = yield* Effect.flip(destroy("linked"));
        expect(
          Predicate.isTagged(linkedRefusal, "WorkspaceUnlanded") &&
            linkedRefusal.refs
        ).toEqual(["worktrees/fixture/HEAD"]);
        yield* fs.writeFileString(`${linked}/HEAD`, `${landedHead}\n`);
        const stashLog = `${work}/.git/logs/refs/stash`;

        for (const fifo of [
          stashLog,
          `${work}/.git/objects/info/commit-graph`,
        ]) {
          yield* checked({ executable: "mkfifo", args: [fifo] });

          const blocked = yield* TestClock.withLive(
            destroy("git-fifo").pipe(Effect.timeout("2 seconds"), Effect.flip)
          );

          expect(Predicate.isTagged(blocked, "WorkspaceUnlanded")).toBe(true);
          yield* fs.remove(fifo);
        }

        yield* git("update-ref", "refs/stash", landedHead);
        yield* fs.writeFileString(
          stashLog,
          `${"0".repeat(40)} ${abandoned} Fixture <fixture@example.invalid> 1 +0000\tolder stash\n` +
            `${abandoned} ${landedHead} Fixture <fixture@example.invalid> 2 +0000\tcurrent stash\n`
        );
        const stashRefusal = yield* Effect.flip(destroy("all-stashes"));
        expect(
          Predicate.isTagged(stashRefusal, "WorkspaceUnlanded") &&
            stashRefusal.refs
        ).toEqual(["stash@{1}"]);
        yield* git("update-ref", "-d", "refs/stash");
        yield* git("config", "core.worktree", fixture.config.metadata);
        const final = yield* destroy("verified");
        expect(final).toMatchObject({
          abandoned: [abandoned],
          ignored: 1,
          state: "destroyed",
        });
      }).pipe(
        Effect.provide(
          Boxes.layer(fixture.config).pipe(Layer.provide(fixture.disk))
        ),
        Effect.provideService(Runner, fixture.runner)
      );
    }).pipe(
      Effect.provide(
        boxRunnerLayer().pipe(
          Layer.provideMerge(
            Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
          )
        )
      )
    )
);

it.effect(
  "resumed teardown archives snapshot-only history and uses only live work as the landed proof",
  () =>
    Effect.gen(function* supersededSnapshot() {
      const fixture = yield* custodyFixture;
      const fs = yield* FileSystem.FileSystem;
      const peonId = "snapshot-history";
      const base = `${fixture.root}/boxes/${peonId}`;
      const raw = "snapshot-only raw transcript\n";
      const logs = ".cache/claude-cli-nodejs/-work/mcp-logs-custom-tools";

      const histories = [
        ".pi/agent/sessions/only-in-snapshot.jsonl",
        `${logs}/only-in-snapshot.jsonl`,
      ];

      yield* Effect.gen(function* lifecycle() {
        const boxes = yield* Boxes;
        yield* boxes.create({
          peonId,
          requestId: "create",
          template: fixture.template,
        });
        yield* boxes.act({
          action: "prompt",
          peonId,
          requestId: "turn",
          text: "before snapshot",
        });
        yield* fs.makeDirectory(`${base}/home/${logs}`, { recursive: true });

        for (const history of histories) {
          yield* fs.writeFileString(`${base}/home/${history}`, raw);
        }

        const parked = yield* boxes.act({
          action: "hibernate",
          peonId,
          requestId: "hibernate",
          retained: true,
        });

        const snapshot = yield* Schema.decodeUnknownEffect(Snapshot)(
          parked.snapshot
        );

        expect(snapshot.retained).toBe(true);
        yield* boxes.act({ action: "resume", peonId, requestId: "resume" });

        for (const history of histories) {
          yield* fs.remove(`${base}/home/${history}`);
        }

        const exported = yield* Schema.decodeUnknownEffect(Export)(
          yield* boxes.act({ action: "export", peonId })
        );

        yield* fixture.replicate(exported.exportReceipt.id);

        const deletion: Parameters<typeof boxes.act>[0] = {
          action: "destroy",
          peonId,
          requestId: "same-request",
          landedHead: fixture.template.workspace.sha,
        };

        const refused = yield* Effect.flip(
          boxes.act({ ...deletion, landedHead: "1".repeat(40) })
        );

        expect(refused._tag).toBe("WorkspaceUnlanded");
        yield* fs.remove(`${base}/work/result.txt`);
        const result = yield* boxes.act(deletion);
        expect(result).toMatchObject({
          state: "destroyed",
          snapshotKept: false,
          snapshotWorkSuperseded: true,
          snapshotBytes: snapshot.bytes,
        });
        expect(yield* fs.exists(snapshot.path)).toBe(false);

        for (const root of Object.values(fixture.roots)) {
          const archive = `${root}/${exported.exportReceipt.id}`;

          const checksums = yield* fs.readFileString(
            `${archive}/MANIFEST.sha256`
          );

          for (const history of histories) {
            expect(
              yield* fs.readFileString(`${archive}/snapshot/${history}`)
            ).toBe(raw);
            expect(checksums).toContain(
              `${sha256(raw)}  snapshot/${history}\n`
            );
          }
        }
      }).pipe(
        Effect.provide(
          Boxes.layer(fixture.config).pipe(Layer.provide(fixture.disk))
        ),
        Effect.provideService(Runner, fixture.runner)
      );
    }).pipe(
      Effect.provide(
        boxRunnerLayer().pipe(
          Layer.provideMerge(
            Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
          )
        )
      )
    )
);

it.effect.each(["live", "snapshot"])(
  "derived JSONL from anywhere in the %s home is verified before destroy",
  (source) =>
    Effect.gen(function* derivedHomeCustody() {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* custodyFixture;
      yield* Effect.gen(function* lifecycle() {
        const boxes = yield* Boxes;
        const peonId = "derived-home";
        const home = `${fixture.root}/boxes/${peonId}/home`;
        const paths = [".cache/x/fixture.jsonl", "tmp/scratch.jsonl"];
        const raw = '{"message":"derived fixture"}\n';

        yield* boxes.create({
          peonId,
          template: fixture.template,
          requestId: "create",
        });
        yield* fs.makeDirectory(`${home}/.cache/x`, { recursive: true });
        yield* fs.makeDirectory(`${home}/tmp`);

        for (const relative of paths) {
          yield* fs.writeFileString(`${home}/${relative}`, raw);
        }

        if (source === "snapshot") {
          yield* boxes.act({
            action: "hibernate",
            peonId,
            requestId: "hibernate",
          });
          yield* boxes.act({ action: "resume", peonId, requestId: "resume" });

          for (const relative of paths) {
            yield* fs.remove(`${home}/${relative}`);
          }

          yield* fs.makeDirectory(`${home}/snapshot/tmp`, { recursive: true });
          yield* fs.writeFileString(
            `${home}/snapshot/tmp/scratch.jsonl`,
            "live bytes\n"
          );
        }

        const exported = yield* Schema.decodeUnknownEffect(Export)(
          yield* boxes.act({ action: "export", peonId })
        );

        yield* fixture.replicate(exported.exportReceipt.id);

        for (const root of Object.values(fixture.roots)) {
          const archive = `${root}/${exported.exportReceipt.id}`;

          const checksums = yield* fs.readFileString(
            `${archive}/MANIFEST.sha256`
          );

          for (const relative of paths) {
            const name =
              source === "snapshot" ? `snapshot/${relative}` : relative;

            expect(checksums).toContain(`${sha256(raw)}  ${name}\n`);
            expect(yield* fs.readFileString(`${archive}/${name}`)).toBe(raw);
          }

          if (source === "snapshot") {
            const live = `__escaped__${sha256("snapshot")}/tmp/scratch.jsonl`;
            expect(yield* fs.readFileString(`${archive}/${live}`)).toBe(
              "live bytes\n"
            );
          }
        }

        const result = yield* boxes.act({
          action: "destroy",
          peonId,
          requestId: "destroy",
          discardWorkspace: true,
        });

        expect(result.state).toBe("destroyed");
        expect(yield* fs.exists(home)).toBe(false);
      }).pipe(
        Effect.provide(
          Boxes.layer(fixture.config).pipe(Layer.provide(fixture.disk))
        ),
        Effect.provideService(Runner, fixture.runner)
      );
    }).pipe(
      Effect.provide(
        boxRunnerLayer().pipe(
          Layer.provideMerge(
            Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
          )
        )
      )
    )
);

it.effect(
  "derived files skipped by either inventory block whole-box destroy until verified again",
  () =>
    Effect.gen(function* reconcileDerived() {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* custodyFixture;
      yield* Effect.gen(function* derivedCustody() {
        const boxes = yield* Boxes;
        const peonId = "derived";
        const root = `${fixture.root}/boxes/${peonId}/home/.claude/projects`;
        yield* boxes.create({
          peonId,
          template: fixture.template,
          requestId: "create",
        });
        yield* fs.makeDirectory(
          `${fixture.root}/boxes/${peonId}/home/.claude`,
          { recursive: true, mode: 0o770 }
        );
        yield* fs.symlink(fixture.root, root);

        const exported = yield* Schema.decodeUnknownEffect(Export)(
          yield* boxes.act({ action: "export", peonId })
        );

        const manifest = yield* fs.readFileString(
          `${fixture.roots.primary}/${exported.exportReceipt.id}/manifest.json`
        );

        expect(manifest).toContain('"path":".claude/projects"');

        const remove = (requestId: string) =>
          boxes.act({
            action: "destroy",
            peonId,
            requestId,
            discardWorkspace: true,
          });

        const refused = yield* Effect.flip(remove("skipped"));
        expect(refused._tag).toBe("CustodyIncomplete");
        yield* fs.remove(root);
        yield* fs.makeDirectory(root, { mode: 0o770 });
        yield* fs.writeFileString(`${root}/raw.jsonl`, "{}\n");
        expect((yield* Effect.flip(remove("stale")))._tag).toBe(
          "CustodyIncomplete"
        );
        yield* TestClock.adjust(1000);
        yield* boxes.act({ action: "export", peonId });
        yield* fs.writeFileString(
          `${root}/raw.jsonl`,
          "changed derived bytes\n"
        );
        expect((yield* Effect.flip(remove("changed")))._tag).toBe(
          "ReceiptMismatch"
        );
        yield* TestClock.adjust(1000);

        const verified = yield* Schema.decodeUnknownEffect(Export)(
          yield* boxes.act({ action: "export", peonId })
        );

        yield* fixture.replicate(verified.exportReceipt.id);
        expect((yield* remove("verified")).state).toBe("destroyed");
      }).pipe(
        Effect.provide(
          Boxes.layer(fixture.config).pipe(Layer.provide(fixture.disk))
        ),
        Effect.provideService(Runner, fixture.runner)
      );
    }).pipe(
      Effect.provide(
        boxRunnerLayer().pipe(
          Layer.provideMerge(
            Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
          )
        )
      )
    )
);

it.effect(
  "custody preparation refuses unresolved or overlapping roots and the wrong host",
  () =>
    Effect.gen(function* unavailableCustody() {
      const fixture = yield* custodyFixture;

      const receipt = {
        box: "test-box",
        fingerprint: "a".repeat(64),
        peon: "test-peon",
        sha256: "a".repeat(64),
        stamp: "20260101T000000Z",
      };

      for (const { roots, reason } of [
        {
          roots: { ...fixture.roots, primary: `${fixture.root}/missing` },
          reason: "could not be read",
        },
        {
          roots: { ...fixture.roots, primary: fixture.roots.replica },
          reason: "disjoint",
        },
        { roots: fixture.roots, reason: "designated box host" },
      ]) {
        const disk = archiveDiskLayer({
          ...roots,
          checkerHost: "invalid-test-host.",
        });

        const result = yield* ArchivePort.use(({ open }) =>
          open.pipe(
            Effect.flatMap(({ readBack }) => readBack(receipt, "check"))
          )
        ).pipe(
          Effect.provide(disk),
          Effect.provideService(Runner, fixture.runner),
          Effect.catch((error) =>
            Effect.succeed(ReadBackResult.Mismatch({ reason: error.message }))
          )
        );

        expect(
          Predicate.isTagged(result, "Mismatch") && result.reason
        ).toContain(reason);
      }
    }).pipe(
      Effect.provide(
        boxRunnerLayer().pipe(Layer.provideMerge(NodeServices.layer))
      )
    )
);

it.effect(
  "a fake Docker executable preserves workspace and memory across sleep, clone from each sleeping state, snapshot restore and deletion",
  () =>
    Effect.gen(function* lifecycle() {
      yield* Effect.acquireRelease(
        Effect.sync(() => process.umask(0o0077)),
        (mask) => Effect.sync(() => process.umask(mask))
      );
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* harness;
      yield* Effect.gen(function* operations() {
        const boxes = yield* Boxes;

        const created = yield* boxes.create({
          peonId: "source",
          requestId: "create",
          template: fixture.template,
        });

        expect(
          yield* boxes.create({
            peonId: "source",
            requestId: "create",
            template: fixture.template,
          })
        ).toEqual(created);
        expect(
          yield* fs.readFileString(
            `${fixture.root}/boxes/source/home/warm/docs/guide.md`
          )
        ).toBe("Warm guide");
        expect(
          yield* fs.readFileString(
            `${fixture.root}/boxes/source/home/append-system.md`
          )
        ).toBe("Warm system\n\nWarm contract");

        const first = yield* boxes.act({
          action: "prompt",
          peonId: "source",
          requestId: "turn",
          text: "write then test",
        });

        expect(
          yield* Schema.decodeUnknownEffect(PromptResult)(first)
        ).toMatchObject({
          exit: 0,
          output: "verdict",
          resumeMs: 0,
          toolCalls: ["read"],
          usage: { total: 2 },
        });
        expect(
          yield* boxes.act({
            action: "prompt",
            peonId: "source",
            requestId: "turn",
            text: "different text must not execute",
          })
        ).toEqual(first);

        const session = yield* fs.readFileString(
          `${fixture.root}/boxes/source/home/session.jsonl`
        );

        expect(session).toBe(`${piHeader}\nwrite then test\n`);

        const partial = yield* fixture.runner.run({
          executable: "docker",
          args: [
            "run",
            "--user",
            "0:1000",
            "--mount",
            `type=bind,source=${fixture.root}/boxes/source,target=/box`,
            "--entrypoint",
            "/bin/sh",
            image,
            "-c",
            "chown -hR 0:1000 /box && chmod -R g+rwX /box && chown -hR 65534:1000 /box",
          ],
        });

        expect(partial.exit).toBe(1);
        expect(yield* fs.exists(`${fixture.root}/partial-root-owned`)).toBe(
          true
        );
        yield* fs.writeFileString(
          `${fixture.root}/recovery-error`,
          "chown: changing ownership of '/box/home': Permission denied\n"
        );
        expect((yield* Effect.flip(boxes.inspect("source"))).status).toBe(503);
        expect(yield* fs.exists(`${fixture.root}/partial-root-owned`)).toBe(
          true
        );
        yield* fs.writeFileString(
          `${fixture.root}/recovery-error`,
          "/usr/bin/find: '/outside': Permission denied\n"
        );
        expect((yield* Effect.flip(boxes.inspect("source"))).status).toBe(503);
        yield* fs.remove(`${fixture.root}/recovery-error`);
        yield* boxes.inspect("source");
        yield* fs.writeFileString(`${fixture.root}/outside-box`, "unchanged", {
          mode: 0o600,
        });
        yield* fs.symlink(
          `${fixture.root}/outside-box`,
          `${fixture.root}/boxes/source/work/escape`
        );
        yield* fs.writeFileString(`${fixture.root}/manager-owned`, "source");
        yield* fs.chmod(`${fixture.root}/boxes/source`, 0o700);
        yield* fs.writeFileString(
          `${fixture.root}/manager-error`,
          "chmod: changing permissions of '/box/home': Operation not permitted\n"
        );
        expect((yield* Effect.flip(boxes.inspect("source"))).status).toBe(503);
        expect(yield* fs.exists(`${fixture.root}/manager-owned`)).toBe(true);
        yield* fs.remove(`${fixture.root}/manager-error`);
        yield* boxes.inspect("source");
        expect(yield* fs.exists(`${fixture.root}/manager-owned`)).toBe(false);
        expect(
          (yield* fs.stat(`${fixture.root}/outside-box`)).mode % 0o1000
        ).toBe(0o600);
        expect(
          (yield* fs.stat(`${fixture.root}/boxes/source`)).mode % 0o1000
        ).toBe(0o770);

        yield* fs.writeFileString(`${fixture.root}/stop-stuck`, "stuck");

        const failedSuspend = yield* Effect.flip(
          boxes.act({
            action: "suspend",
            peonId: "source",
            requestId: "stuck-suspend",
          })
        );

        expect(failedSuspend.status).toBe(503);
        expect(yield* boxes.inspect("source")).toMatchObject({
          processes: 1,
          state: "idle",
        });
        yield* fs.remove(`${fixture.root}/stop-stuck`);

        for (const directory of [
          "",
          "work",
          "home",
          "home/.pi",
          "home/.pi/agent",
          "home/warm",
          "home/warm/docs",
          "home/tool",
          "home/tool/nested",
        ]) {
          const info = yield* fs.stat(
            `${fixture.root}/boxes/source/${directory}`
          );

          expect(info.mode % 0o1000).toBe(0o770);
        }

        for (const file of ["home/session.jsonl", "work/result.txt"]) {
          expect(
            (yield* fs.stat(`${fixture.root}/boxes/source/${file}`)).mode %
              0o1000
          ).toBe(0o660);
        }

        expect(
          yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({ requestId: Schema.String, result: PromptResult })
            )
          )(
            yield* fs.readFileString(
              `${fixture.root}/boxes/source/home/.box/requests/${yield* receiptKey("turn")}.json`
            )
          )
        ).toEqual({ requestId: "turn", result: first });

        for (const state of ["idle", "suspended", "hibernated"]) {
          yield* fs.chmod(
            `${fixture.root}/boxes/source/home/.claude/projects`,
            0o700
          );

          if (state === "suspended") {
            yield* boxes.act({
              action: "suspend",
              peonId: "source",
              requestId: "sleep",
            });
          }

          if (state === "hibernated") {
            yield* boxes.act({
              action: "hibernate",
              peonId: "source",
              requestId: "hibernate",
            });
          }

          const result = yield* boxes.act({
            action: "clone",
            newPeonId: `copy-${state}`,
            peonId: "source",
            requestId: `clone-${state}`,
          });

          expect(result).toEqual({
            peonId: `copy-${state}`,
            state: "suspended",
          });
          expect(
            yield* fs.readFileString(
              `${fixture.root}/boxes/copy-${state}/home/session.jsonl`
            )
          ).toBe(session);
          expect(yield* boxes.inspect(`copy-${state}`)).toMatchObject({
            processes: 0,
            state: "suspended",
          });
        }

        expect(yield* fs.exists(`${fixture.root}/boxes/source`)).toBe(false);
        expect(
          yield* boxes.act({
            action: "resume",
            peonId: "source",
            requestId: "restore",
          })
        ).toEqual({ restored: true, state: "idle" });
        expect(
          yield* fs.readFileString(
            `${fixture.root}/boxes/source/home/session.jsonl`
          )
        ).toBe(session);
        expect(
          yield* fs.readFileString(
            `${fixture.root}/boxes/source/work/result.txt`
          )
        ).toBe("changed by tool\n");
        yield* boxes.act({
          action: "suspend",
          peonId: "source",
          requestId: "sleep-again",
        });
        expect(yield* boxes.inspect("source")).toMatchObject({
          processes: 0,
          state: "suspended",
        });

        const woke = yield* Schema.decodeUnknownEffect(PromptResult)(
          yield* boxes.act({
            action: "prompt",
            peonId: "source",
            requestId: "mail:../../wake/..",
            text: "continue from memory",
          })
        );

        expect(woke.resumeMs).toBeGreaterThanOrEqual(0);
        expect(
          (yield* fs.readDirectory(
            `${fixture.root}/metadata/source/requests`
          )).every((name) => /^[0-9a-f]{64}\.json$/u.test(name))
        ).toBe(true);
        expect(yield* boxes.inspect("source")).toMatchObject({
          processes: 1,
          state: "idle",
        });
        yield* fs.chmod(
          `${fixture.root}/boxes/source/home/.claude/projects`,
          0o700
        );

        const finalSnapshot = yield* Schema.decodeUnknownEffect(Snapshot)(
          (yield* boxes.act({
            action: "hibernate",
            peonId: "source",
            requestId: "final-snapshot",
          })).snapshot
        );

        const exported = yield* boxes.act({
          action: "export",
          peonId: "source",
          requestId: "export-history",
        });

        expect(
          yield* boxes.act({
            action: "destroy",
            peonId: "source",
            discardWorkspace: true,
            requestId: "delete",
          })
        ).toMatchObject({
          bytesFreed: finalSnapshot.bytes,
          exportReceipt: exported.exportReceipt,
          snapshotKept: false,
          state: "destroyed",
        });
        expect(yield* fs.exists(finalSnapshot.path)).toBe(false);
        expect(yield* boxes.inspect("source")).toMatchObject({
          bytes: { home: 0, work: 0 },
          processes: 0,
          state: "destroyed",
        });
        expect(yield* fs.exists(`${fixture.root}/snapshots/source`)).toBe(true);
        const commands = yield* fs.readFileString(`${fixture.root}/commands`);

        const creates = commands
          .split("\n")
          .filter((line) => line.startsWith("create "));

        expect(creates.length).toBeGreaterThan(0);

        const helpers = commands
          .split("\n")
          .filter(
            (line) => line.startsWith("run ") && line.includes("--cap-drop")
          );

        expect(helpers.length).toBeGreaterThan(0);
        expect(helpers.some((line) => line.includes("--user 65534:1000"))).toBe(
          true
        );

        for (const command of helpers.filter((line) =>
          line.includes("--user 0:1000")
        )) {
          expect(command).toContain(
            "--network none --read-only --cap-drop ALL --cap-add CHOWN"
          );
          expect(command).toContain(
            "--security-opt no-new-privileges --user 0:1000"
          );
          expect(command).not.toMatch(/DAC_OVERRIDE|DAC_READ_SEARCH|FOWNER/u);
        }

        for (const command of creates) {
          expect(command).toContain("--network mischief-peon-boxes");
          expect(
            command.match(/--mount type=bind,source=[^ ]+,target=[^ ]+/gu)
          ).toEqual([
            expect.stringMatching(/,target=\/work$/u),
            expect.stringMatching(/,target=\/home\/peon$/u),
          ]);
          expect(command).toContain(
            "--read-only --tmpfs /tmp:rw,nosuid,nodev,size=384m"
          );

          for (const value of [
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
            "CLAUDE_CONFIG_DIR=/home/peon/.claude",
          ]) {
            expect(command).toContain(`--env ${value}`);
          }
        }

        expect(commands).toContain(
          "--cap-drop ALL --security-opt no-new-privileges --user 65534:1000"
        );
        expect(commands).toContain("--env CODEX_HOME=/home/peon/.codex");
        expect(commands).toContain(
          "--cgroup-parent mischief-peon-boxes.slice --read-only --tmpfs /tmp:rw,nosuid,nodev,size=384m --dns 1.1.1.1 --dns 9.9.9.9"
        );
        expect(commands).not.toContain("--no-");
        expect(commands).not.toContain("write then test");
      }).pipe(
        Effect.provide(
          Boxes.layer(fixture.config).pipe(Layer.provide(ArchivePort.memory))
        ),
        Effect.provideService(Runner, fixture.runner)
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        boxRunnerLayer().pipe(
          Layer.provideMerge(
            Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
          )
        )
      )
    )
);

it.effect("ownership failures retain capped, redacted helper stderr", () =>
  Effect.gen(function* helperFailure() {
    const fs = yield* FileSystem.FileSystem;
    const fixture = yield* harness;
    yield* fs.writeFileString(
      `${fixture.root}/helper-error`,
      `cannot read directory '/box': Permission denied\nBearer fake-bearer token=fake-token password=fake-password https://user:fake-password@example.invalid ${"x".repeat(1024)}`
    );
    yield* Effect.gen(function* operation() {
      const boxes = yield* Boxes;

      const failure = yield* Effect.flip(
        boxes.create({
          peonId: "source",
          requestId: "create",
          template: fixture.template,
        })
      );

      expect(failure.status).toBe(503);
      expect(failure.message).toContain(
        "cannot read directory '/box': Permission denied"
      );
      expect(failure.message).toContain("[redacted]");
      expect(failure.message).not.toMatch(
        /fake-bearer|fake-token|fake-password|example\.invalid/u
      );
      expect(failure.message.length).toBeLessThan(800);
    }).pipe(
      Effect.provide(
        Boxes.layer(fixture.config).pipe(Layer.provide(ArchivePort.memory))
      ),
      Effect.provideService(Runner, fixture.runner)
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      boxRunnerLayer().pipe(
        Layer.provideMerge(
          Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
        )
      )
    )
  )
);

it.effect("a changed snapshot fails its sha check before restoration", () =>
  Effect.gen(function* snapshotTamper() {
    const fs = yield* FileSystem.FileSystem;
    const fixture = yield* harness;
    yield* Effect.gen(function* operations() {
      const boxes = yield* Boxes;
      yield* boxes.create({
        peonId: "source",
        requestId: "create",
        template: fixture.template,
      });

      const hibernated = yield* boxes.act({
        action: "hibernate",
        peonId: "source",
        requestId: "hibernate",
      });

      const snapshot = yield* Schema.decodeUnknownEffect(Snapshot)(
        hibernated.snapshot
      );

      yield* fs.writeFileString(snapshot.path, "tampered bytes");

      const failure = yield* Effect.flip(
        boxes.act({ action: "resume", peonId: "source", requestId: "restore" })
      );

      expect(failure).toMatchObject({ status: 409 });
      expect(failure.message).toContain("sha256");
      expect(yield* fs.exists(`${fixture.root}/boxes/source`)).toBe(false);
    }).pipe(
      Effect.provide(
        Boxes.layer(fixture.config).pipe(Layer.provide(ArchivePort.memory))
      ),
      Effect.provideService(Runner, fixture.runner)
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      boxRunnerLayer().pipe(
        Layer.provideMerge(
          Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
        )
      )
    )
  )
);

it.effect(
  "an active prompt rejects a second prompt and clone without copying a changing session",
  () =>
    Effect.gen(function* contention() {
      const fixture = yield* harness;
      const baseRunner = fixture.runner;
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const calls = yield* Ref.make(0);

      const slowRunner = Runner.of({
        run: (command) =>
          command.args.includes("pi")
            ? Deferred.succeed(entered, true).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Ref.update(calls, (count) => count + 1)),
                Effect.andThen(baseRunner.run(command))
              )
            : baseRunner.run(command),
      });

      yield* Effect.gen(function* operations() {
        const boxes = yield* Boxes;
        yield* boxes.create({
          peonId: "source",
          requestId: "create",
          template: fixture.template,
        });

        const prompt = yield* Effect.forkChild(
          boxes.act({
            action: "prompt",
            peonId: "source",
            requestId: "turn",
            text: "work",
          })
        );

        yield* Deferred.await(entered);

        const exporting = yield* Effect.flip(
          boxes.act({ action: "export", peonId: "source" })
        );

        expect(exporting.message).toContain("not stopped");
        expect(
          (yield* Effect.flip(
            boxes.act({
              action: "prompt",
              peonId: "source",
              requestId: "other-turn",
              text: "overlap",
            })
          )).status
        ).toBe(409);
        expect(
          (yield* Effect.flip(
            boxes.act({
              action: "clone",
              newPeonId: "copy",
              peonId: "source",
              requestId: "clone",
            })
          )).status
        ).toBe(409);
        yield* Deferred.succeed(release, true);
        yield* Fiber.join(prompt);
        expect(yield* Ref.get(calls)).toBe(1);
      }).pipe(
        Effect.provide(
          Boxes.layer(fixture.config).pipe(Layer.provide(ArchivePort.memory))
        ),
        Effect.provideService(Runner, slowRunner)
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        boxRunnerLayer().pipe(
          Layer.provideMerge(
            Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
          )
        )
      )
    )
);

it.effect.prop(
  "box histories refuse cloning and lifecycle mutations while running",
  {
    events: Arbitrary.array(
      Arbitrary.schema(
        Schema.Literals([
          "PROMPT",
          "CLONE",
          "SUSPEND",
          "RESUME",
          "HIBERNATE",
          "EXPORT",
          "DESTROY",
          "DONE",
        ])
      ),
      { maxLength: 60 }
    ),
    states: Arbitrary.schema(State),
  },
  ({ states, events }) =>
    Effect.gen(function* history() {
      let state = states;

      for (const event of events) {
        if (state === "running" && event !== "DONE") {
          expect((yield* Effect.flip(nextState(state, event))).status).toBe(
            409
          );
        } else {
          const previous = state;
          state = yield* nextState(state, event).pipe(
            Effect.orElseSucceed(() => previous)
          );
        }
      }
    })
);

it.effect(
  "host receipts survive manager reconstruction, reject forged home results and stop failed turns",
  () =>
    Effect.gen(function* receipts() {
      const fixture = yield* harness;
      const fs = yield* FileSystem.FileSystem;
      const calls = yield* Ref.make(0);

      const failing = Runner.of({
        run: (command) =>
          command.args.includes("pi")
            ? Ref.update(calls, (value) => value + 1).pipe(
                Effect.as({ exit: 1, stdout: "" })
              )
            : fixture.runner.run(command),
      });

      yield* Effect.gen(function* firstManager() {
        const boxes = yield* Boxes;
        yield* boxes.create({
          peonId: "source",
          requestId: "create",
          template: fixture.template,
        });
        expect(
          (yield* Effect.flip(
            boxes.act({
              action: "prompt",
              peonId: "source",
              requestId: "failed-turn",
              text: "work",
            })
          )).status
        ).toBe(502);
        expect(yield* boxes.inspect("source")).toMatchObject({
          processes: 0,
          state: "suspended",
        });
      }).pipe(
        Effect.provide(
          Boxes.layer(fixture.config).pipe(Layer.provide(ArchivePort.memory))
        ),
        Effect.provideService(Runner, failing)
      );
      yield* fs.makeDirectory(
        `${fixture.root}/boxes/source/home/.box/requests`,
        { recursive: true }
      );
      yield* fs.writeFileString(
        `${fixture.root}/boxes/source/home/.box/requests/${yield* receiptKey("failed-turn")}.json`,
        JSON.stringify({ output: "forged" })
      );
      yield* Effect.gen(function* restartedManager() {
        const boxes = yield* Boxes;

        const failure = yield* Effect.flip(
          boxes.act({
            action: "prompt",
            peonId: "source",
            requestId: "failed-turn",
            text: "different text",
          })
        );

        expect(failure.status).toBe(502);
        expect(yield* Ref.get(calls)).toBe(1);
        expect(
          yield* boxes.create({
            peonId: "source",
            requestId: "create",
            template: fixture.template,
          })
        ).toMatchObject({ peonId: "source", state: "idle" });

        const result = yield* boxes.act({
          action: "prompt",
          peonId: "source",
          requestId: "fresh-turn",
          text: "continue",
        });

        expect(result).toMatchObject({ output: "verdict" });
        yield* fs.writeFileString(
          `${fixture.root}/metadata/source/requests/${yield* receiptKey("fresh-turn")}.json`,
          JSON.stringify({ requestId: "different-raw-id" })
        );

        const collision = yield* Effect.flip(
          boxes.act({
            action: "prompt",
            peonId: "source",
            requestId: "fresh-turn",
            text: "must not run",
          })
        );

        expect(collision.status).toBe(409);
        expect(collision.message).toContain("different raw requestId");
      }).pipe(
        Effect.provide(
          Boxes.layer(fixture.config).pipe(Layer.provide(ArchivePort.memory))
        ),
        Effect.provideService(Runner, fixture.runner)
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        boxRunnerLayer().pipe(
          Layer.provideMerge(
            Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
          )
        )
      )
    )
);
