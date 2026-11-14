import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Ref,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import * as Digest from "effect/crypto/Digest";

import { nextState } from "../src/box/machine.js";
import { Boxes } from "../src/box/manager.js";
import { PromptResult, Snapshot, State } from "../src/box/protocol.js";
import type { BoxTemplate } from "../src/box/protocol.js";
import { receiptKey } from "../src/box/receipt.js";
import { boxRunnerLayer } from "../src/box/runner.js";
import { checked, Runner } from "../src/runner.js";
import { image, piOutput, sha } from "./fixtures.js";

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

  const root = yield* fs.makeTempDirectoryScoped({
    directory: process.cwd(),
    prefix: ".box-test-",
  });

  yield* fs.makeDirectory(`${root}/bin`);
  yield* fs.makeDirectory(`${root}/fake`);

  const script = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> '${root}/commands'
command="$1"; shift
case "$command" in
run)
  if [ -f '${root}/helper-error' ]; then cat '${root}/helper-error' >&2; exit 1; fi
  previous=''
  box=''
  for arg in "$@"; do
    if [ "$previous" = --user ]; then test "$arg" = 0:1000; fi
    case "$arg" in type=bind,source=*,target=/box) box="\${arg#type=bind,source=}"; box="\${box%,target=/box}";; esac
    previous="$arg"
  done
  test -n "$box"
  if find "$box" -type d ! -perm 0770 | grep -q .; then
    printf 'group cannot traverse box directories\\n' >&2
    exit 1
  fi
  exit 0;;
create)
  test "$1" = --name
  name="$2"
  printf stopped > '${root}/fake/'"$name"
  ;;
start) printf running > '${root}/fake/'"$1";;
stop) printf stopped > '${root}/fake/'"$1";;
rm) for name in "$@"; do case "$name" in mischief-peon-box-*) unlink '${root}/fake/'"$name";; esac; done;;
inspect)
  shift; shift
  if grep -qx running '${root}/fake/'"$1"; then printf '{"Running":true,"Pid":123}'; else printf '{"Running":false,"Pid":0}'; fi;;
top) printf 'PID\\n123\\n';;
exec)
  while [ "\${1#mischief-peon-box-}" = "$1" ]; do shift; done
  id="\${1#mischief-peon-box-}"; shift
  if [ "$1" = /bin/sh ]; then
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
    `${root}/bin/pi`,
    `#!/bin/sh
set -eu
id="$PEON_TEST_ID"
input="$(cat)"
printf '%s\\n' "$input" >> '${root}/boxes/'"$id"'/home/session.jsonl'
mkdir -p '${root}/boxes/'"$id"'/home/tool/nested'
printf 'changed by tool\\n' > '${root}/boxes/'"$id"'/work/result.txt'
printf '%s\\n' '${piOutput}'
`,
    { mode: 0o700 }
  );
  const source = `${root}/source`;
  yield* checked({ args: ["init", source], executable: "git" });
  yield* fs.writeFileString(`${source}/proof.txt`, "pinned contents\n");
  yield* checked({
    args: ["-C", source, "add", "proof.txt"],
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

        expect(session).toBe("write then test\n");

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
        expect(
          yield* boxes.act({
            action: "destroy",
            peonId: "source",
            requestId: "delete",
          })
        ).toEqual({ snapshotKept: true, state: "destroyed" });
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
          .filter((line) => line.startsWith("run "));

        expect(helpers.length).toBeGreaterThan(0);

        for (const command of helpers) {
          expect(command).toContain(
            "--network none --read-only --cap-drop ALL --cap-add CHOWN"
          );
          expect(command).toContain(
            "--security-opt no-new-privileges --user 0:1000"
          );
          expect(command).not.toMatch(/DAC_OVERRIDE|FOWNER/u);
        }

        for (const command of creates) {
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
        expect(
          commands
            .split("\n")
            .filter((line) => line.startsWith("create "))
            .map((line) => line.replaceAll(fixture.root, "/fixture"))
        ).toMatchSnapshot();
        expect(commands).toContain(
          "--cgroup-parent mischief-peon-boxes.slice --read-only --tmpfs /tmp:rw,nosuid,nodev,size=384m --dns 1.1.1.1 --dns 9.9.9.9"
        );
        expect(commands).not.toContain("--no-");
        expect(commands).not.toContain("write then test");
      }).pipe(
        Effect.provide(Boxes.layer(fixture.config)),
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
      Effect.provide(Boxes.layer(fixture.config)),
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
      Effect.provide(Boxes.layer(fixture.config)),
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
        Effect.provide(Boxes.layer(fixture.config)),
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
        Effect.provide(Boxes.layer(fixture.config)),
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
        Effect.provide(Boxes.layer(fixture.config)),
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
