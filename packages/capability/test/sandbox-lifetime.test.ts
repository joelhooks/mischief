import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Predicate,
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { Cause } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Sandbox } from "../src/sandbox-service.js";
import { RUNNER_SOURCE, layerSubprocess } from "../src/sandbox-subprocess.js";

const parentScript = new URL(
  "../scripts/sandbox-lifetime-parent.mjs",
  import.meta.url
).pathname;

const stubbornSource = `
import { spawn } from "node:child_process";
process.on("SIGTERM", () => {});
const descendant = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
descendant.stdout.once("data", () => {
  process.stdout.write(JSON.stringify({ type: "call", id: 1, name: "ready", input: { descendant: descendant.pid } }) + "\\n");
});
setInterval(() => {}, 1000);
`;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }

    throw error;
  }
};

const awaitDeath = (pid: number) =>
  Effect.sync(() => isAlive(pid)).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 millis"),
      while: (alive) => alive,
    })
  );

const markedSandboxes = Effect.fn("markedSandboxes")(function* markedSandboxes(
  marker: string
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const table = yield* spawner.string(
    ChildProcess.make("ps", ["-axo", "pid,command"])
  );

  return table
    .split("\n")
    .filter(
      (row) =>
        row.includes("--disallow-code-generation-from-strings") &&
        row.endsWith(marker)
    );
});

const Called = Schema.Struct({ descendant: Schema.Int });

const escalation = Effect.fn("sandboxEscalation")(function* escalation(
  close: "interrupt" | "scope"
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const marker = `sandbox-lifetime-${close}-${process.pid}`;
  const sandboxPid = yield* Deferred.make<number>();
  const descendantPid = yield* Deferred.make<number>();

  const observed = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
    ...spawner,
    spawn: (command) =>
      Predicate.isTagged(command, "StandardCommand")
        ? spawner
            .spawn(
              ChildProcess.make(
                command.command,
                ["--input-type=module", "-e", stubbornSource, "--", marker],
                command.options
              )
            )
            .pipe(
              Effect.tap((handle) => Deferred.succeed(sandboxPid, handle.pid))
            )
        : Effect.die("Expected a standard sandbox command"),
  });

  yield* Effect.scoped(
    Effect.gen(function* closeOwningScope() {
      const fiber = yield* Sandbox.use((sandbox) =>
        sandbox.run("tools.ready({}); for (;;) {}", (_name, input) =>
          Schema.decodeUnknownEffect(Called)(input).pipe(
            Effect.flatMap(({ descendant }) =>
              Deferred.succeed(descendantPid, descendant)
            ),
            Effect.as({ ok: true, value: null } as const),
            Effect.orDie
          )
        )
      ).pipe(Effect.forkScoped);

      yield* Deferred.await(descendantPid);

      if (close === "interrupt") {
        yield* Fiber.interrupt(fiber);
      }
    })
  ).pipe(
    Effect.provide(
      layerSubprocess({ timeout: "60 seconds" }).pipe(Layer.provide(observed))
    )
  );

  yield* awaitDeath(yield* Deferred.await(sandboxPid));
  yield* awaitDeath(yield* Deferred.await(descendantPid));
  expect(yield* markedSandboxes(marker)).toEqual([]);
}, Effect.provide(NodeServices.layer));

interface RunnerExit {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

const runnerExit = Effect.fn("sandboxRunnerExit")(
  function* runnerExit(mode: "cpu" | "deadline" | "eof") {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          "--permission",
          "--disallow-code-generation-from-strings",
          "--input-type=module",
          "-e",
          RUNNER_SOURCE,
          "--",
          `sandbox-lifetime-${mode}-${process.pid}`,
        ],
        { env: {}, extendEnv: false }
      )
    );

    const inbox = yield* Queue.unbounded<Uint8Array, Cause.Done>();

    yield* Stream.fromQueue(inbox).pipe(
      Stream.run(handle.stdin),
      Effect.ignore,
      Effect.forkScoped
    );

    yield* Queue.offer(
      inbox,
      new TextEncoder().encode(
        `${JSON.stringify({
          code: mode === "cpu" ? "for (;;) {}" : "await new Promise(() => {})",
          names: [],
          timeoutMillis: mode === "eof" ? 60_000 : 50,
          type: "run",
        })}\n`
      )
    );

    if (mode === "eof") {
      yield* Queue.end(inbox);
    }

    const [code, stderr, stdout] = yield* Effect.all(
      [
        handle.exitCode,
        Stream.mkString(Stream.decodeText(handle.stderr)),
        Stream.mkString(Stream.decodeText(handle.stdout)),
      ],
      { concurrency: "unbounded" }
    );

    return { code, stderr, stdout } satisfies RunnerExit;
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer)
);

const killedParent = Effect.fn("sandboxKilledParent")(
  function* killedParent() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const marker = `sandbox-lifetime-kill-parent-${process.pid}`;

    const parent = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [parentScript, marker])
    );

    const lines = yield* parent.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.takeUntil((line) => line === "READY"),
      Stream.runCollect
    );

    const sandboxPid = Number(
      lines.find((line) => line.startsWith("PID "))?.slice("PID ".length)
    );

    expect(Number.isInteger(sandboxPid)).toBe(true);
    expect(lines.at(-1)).toBe("READY");

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (isAlive(sandboxPid)) {
          process.kill(sandboxPid, "SIGKILL");
        }
      })
    );

    yield* parent.kill({ killSignal: "SIGKILL" });
    yield* awaitDeath(sandboxPid);
    expect(yield* markedSandboxes(marker)).toEqual([]);
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer)
);

const scopedRun = Effect.fn("scopedSandboxRun")(function* scopedRun(
  interrupt: boolean
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const started =
    yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();

  const observed = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
    ...spawner,
    spawn: (command) =>
      spawner
        .spawn(command)
        .pipe(Effect.tap((handle) => Deferred.succeed(started, handle))),
  });

  const handle = yield* Effect.scoped(
    Effect.gen(function* handle() {
      const sandbox = yield* Sandbox;

      const fiber = yield* sandbox
        .run("for (;;) {}", () => Effect.succeed({ ok: true, value: null }))
        .pipe(Effect.forkScoped);

      const child = yield* Deferred.await(started);

      if (interrupt) {
        yield* Fiber.interrupt(fiber);
      }

      return child;
    }).pipe(
      Effect.provide(
        layerSubprocess({ timeout: "60 seconds" }).pipe(Layer.provide(observed))
      )
    )
  );

  expect(yield* handle.isRunning).toBe(false);
}, Effect.provide(NodeServices.layer));

describe("sandbox lifetime", () => {
  it.live("kills its child when the run is interrupted", () => scopedRun(true));
  it.live("kills its child when the owning scope closes", () =>
    scopedRun(false)
  );
  it.live("escalates scope close and kills resistant descendants", () =>
    escalation("scope")
  );
  it.live("escalates interruption and kills resistant descendants", () =>
    escalation("interrupt")
  );
  it.live("bounds an infinite loop after a capability reply", () =>
    Effect.gen(function* boundsContinuation() {
      const sandbox = yield* Sandbox;

      const error = yield* sandbox.run(
        "await tools.ready({}); for (;;) {}",
        () => Effect.succeed({ ok: true, value: null })
      );

      expect(error.diagnostic?.kind).toBe("TimeoutExceeded");
    }).pipe(
      Effect.provide(
        layerSubprocess({ timeout: "300 millis" }).pipe(
          Layer.provide(NodeServices.layer)
        )
      )
    )
  );
  it.live("exits on stdin EOF", () =>
    runnerExit("eof").pipe(
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(exit).toEqual({ code: 1, stderr: "", stdout: "" });
        })
      )
    )
  );
  it.live("bounds a synchronous infinite loop inside the child", () =>
    runnerExit("cpu").pipe(
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(exit.code).toBe(0);
          expect(exit.stderr).toBe("");
          expect(exit.stdout).toContain('"reason":"timeout"');
        })
      )
    )
  );
  it.live("enforces a child-side wall clock without a caller", () =>
    runnerExit("deadline").pipe(
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(exit).toEqual({ code: 1, stderr: "", stdout: "" });
        })
      )
    )
  );
  it.live("survives SIGKILL of its parent without an orphan", () =>
    killedParent()
  );
});
