import { expect, it } from "@effect/vitest";
import type { PeonReport } from "@mischief/core";
import { emptyPeonUsage, fullPeonTemplate, PeonRefused } from "@mischief/core";
import { Clock, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";

import type {
  PeonBox,
  PeonBoxRequest,
  PeonBoxOperation,
} from "../src/peon-box.js";
import { peonHost } from "../src/peon-host.js";
import type { PeonHostOptions } from "../src/peon-host.js";
import type { PeonCompleted, PeonStoredValue } from "../src/peon-state.js";

const template = {
  ...fullPeonTemplate,
  workspace: { repo: "example/project", sha: "a".repeat(40) },
};

const entry = {
  owner: "did:web:driver.example.invalid",
  peonId: "peon-a",
  state: "spawned",
  template: { name: "full", version: 1 },
  updatedAt: 0,
} as const;

const turn = {
  exit: 0,
  model: "opus",
  output: "Wrote the file and ran the test",
  thinking: "medium",
  toolCalls: ["edit", "bash"],
  usage: { cacheRead: 10, cacheWrite: 3, input: 20, output: 4, total: 37 },
  wallMs: 12,
};

const fixture = () => {
  let stored: PeonStoredValue | undefined;
  let alarm: number | null = null;
  let crashOnCompletion = false;
  let failNext = false;
  let boxState = "idle";
  const results = new Map<string, typeof PeonCompleted.Type>();
  const boxResults = new Map<string, unknown>();

  const calls: {
    readonly operation: string;
    readonly body: PeonBoxRequest | undefined;
  }[] = [];

  const replies: string[] = [];

  const resultStates = {
    clone: "suspended",
    destroy: "destroyed",
    hibernate: "hibernated",
    resume: "idle",
    suspend: "suspended",
  } satisfies Record<
    Exclude<PeonBoxOperation, "spawn" | "prompt" | "inspect">,
    string
  >;

  const expectedStates = {
    clone: ["idle", "suspended", "hibernated"],
    destroy: ["idle", "suspended", "hibernated"],
    hibernate: ["hibernated"],
    prompt: ["running"],
    resume: ["attaching"],
    spawn: ["attaching"],
    suspend: ["suspended"],
  } satisfies Record<Exclude<PeonBoxOperation, "inspect">, readonly string[]>;

  const box: PeonBox = {
    call: (peonId, operation, body, schema) =>
      Effect.gen(function* call() {
        if (operation !== "inspect") {
          const pending = stored?.pending;

          const expectedRequestId = pending?.boxRequestId;

          expect(pending).not.toBeNull();
          expect(body?.requestId).toBe(expectedRequestId);
          expect(alarm).not.toBeNull();
          expect(expectedStates[operation]).toContain(stored?.report.state);
        }

        calls.push({ body, operation });

        if (failNext) {
          failNext = false;

          return yield* new PeonRefused({
            reason: "Box disappeared; inspectPeon before retrying",
          });
        }

        const key = `${operation}/${body?.requestId}`;
        let value = operation === "inspect" ? undefined : boxResults.get(key);

        if (value === undefined) {
          if (operation === "prompt") {
            value = { ...turn, resumeMs: boxState === "idle" ? 0 : 25 };
            boxState = "idle";
          } else if (operation === "spawn") {
            value = {
              image: "example/image@sha256:abc",
              peonId,
              state: "idle",
              workspace: template.workspace,
            };
          } else if (operation === "inspect") {
            value = {
              bytes: {
                home: boxState === "hibernated" ? 0 : 20,
                snapshot: boxState === "hibernated" ? 30 : 0,
                work: boxState === "hibernated" ? 0 : 10,
              },
              container: "box",
              lastPromptAt: null,
              processes: boxState === "idle" ? 1 : 0,
              state: boxState,
            };
          } else {
            boxState = resultStates[operation];
            value = {
              state: boxState,
            };
          }

          boxResults.set(key, value);
        }

        return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.orDie
        );
      }),
  };

  const options: PeonHostOptions = {
    box,
    clone: (id: string, source: typeof PeonReport.Type) =>
      Effect.succeed({
        ...source,
        peonId: id,
        state: "suspended",
        usage: emptyPeonUsage,
      }),
    guardMs: 30_000,
    publish: () => Effect.void,
    reply: (_to: string, messageId: string) =>
      Effect.sync(() => {
        replies.push(messageId);
      }),
    reserveClone: () => Effect.void,
    storage: {
      commit: (
        next: PeonStoredValue,
        at: number | null,
        completed?: {
          readonly requestId: string;
          readonly value: typeof PeonCompleted.Type;
        }
      ) =>
        Effect.gen(function* commit() {
          if (completed !== undefined && crashOnCompletion) {
            crashOnCompletion = false;

            return yield* Effect.interrupt;
          }

          stored = structuredClone(next);
          alarm = at;

          if (completed !== undefined) {
            results.set(completed.requestId, structuredClone(completed.value));
          }

          return yield* Effect.void;
        }),
      completed: (requestId: string) =>
        Effect.sync(() => results.get(requestId)),
      load: Effect.sync(() => structuredClone(stored)),
    },
  };

  return {
    alarm: () => alarm,
    calls,
    crash: () => {
      crashOnCompletion = true;
    },
    fail: () => {
      failNext = true;
    },
    host: () => peonHost(options),
    read: () => stored,
    replies,
  };
};

it.effect(
  "an interrupted prompt replays the same box request and accounts usage once",
  () =>
    Effect.gen(function* interrupted() {
      const world = fixture();
      yield* world.host().initialize(entry, template, false);
      world.crash();
      yield* world
        .host()
        .command("prompt", "turn-1", "PROMPT", { text: "Edit a file" })
        .pipe(Effect.exit);

      expect(world.read()?.report.state).toBe("running");
      expect(world.read()?.pending?.requestId).toBe("turn-1");
      expect(world.alarm()).not.toBeNull();

      const boxRequestId = world.read()?.pending?.boxRequestId;
      const resumed = yield* world.host().idle();

      const repeated = yield* world
        .host()
        .command("prompt", "turn-1", "PROMPT", { text: "Edit a file" });

      expect(resumed.usage).toStrictEqual(turn.usage);
      expect(repeated).toStrictEqual(resumed);
      expect(
        world.calls
          .filter(({ operation }) => operation === "prompt")
          .map(({ body }) => body?.requestId)
      ).toStrictEqual([boxRequestId, boxRequestId]);

      const conflict = yield* world
        .host()
        .command("prompt", "turn-1", "PROMPT", { text: "Different work" })
        .pipe(Effect.flip);

      expect(conflict.reason).toContain("different input");
    })
);

it.effect(
  "sleep arms only the hibernate alarm, then hibernation disarms it until mail wakes the peon",
  () =>
    Effect.gen(function* sleep() {
      const world = fixture();
      const initial = yield* world.host().initialize(entry, template, false);
      const idleAt = yield* Clock.currentTimeMillis;

      expect(initial.state).toBe("idle");
      expect(initial.bytes).toEqual({ home: 20, snapshot: 0, work: 10 });
      expect(initial.processes).toBe(1);
      expect(world.alarm()).toBe(idleAt + 60_000);

      yield* TestClock.adjust("60 seconds");
      yield* world.host().idle();
      expect(world.read()?.report.state).toBe("suspended");
      expect(world.read()?.report.bytes).toEqual({
        home: 20,
        snapshot: 0,
        work: 10,
      });
      expect(world.read()?.report.processes).toBe(0);
      expect(world.alarm()).toBe(idleAt + 86_400_000);

      yield* TestClock.adjust("24 hours");
      yield* world.host().idle();
      expect(world.read()?.report.state).toBe("hibernated");
      expect(world.read()?.report.bytes).toEqual({
        home: 0,
        snapshot: 30,
        work: 0,
      });
      expect(world.read()?.report.processes).toBe(0);
      expect(world.alarm()).toBeNull();

      yield* world.host().command("prompt", "mail-1", "PROMPT", {
        defer: true,
        mail: true,
        sender: entry.owner,
        text: "Continue",
      });
      expect(world.read()?.pending?.requestId).toBe("mail-1");
      expect(world.alarm()).not.toBeNull();

      yield* world.host().idle();
      expect(world.read()?.report.state).toBe("idle");
      expect(world.replies).toStrictEqual(["mail-1"]);
      expect(world.read()?.report.lastTurn?.resumeMs).toBe(25);
      expect(world.read()?.report.bytes).toEqual({
        home: 20,
        snapshot: 0,
        work: 10,
      });
      expect(world.read()?.report.processes).toBe(1);
    })
);

it.effect(
  "a box failure records BOX_LOST and keeps its durable request for the next alarm",
  () =>
    Effect.gen(function* lost() {
      const world = fixture();
      yield* world.host().initialize(entry, template, false);
      world.fail();
      yield* world
        .host()
        .command("prompt", "lost-1", "PROMPT", { text: "Resume safely" })
        .pipe(Effect.flip);

      expect(world.read()?.report.state).toBe("suspended");
      expect(world.read()?.report.fault).toContain("disappeared");
      expect(world.read()?.pending?.requestId).toBe("lost-1");
      expect(world.alarm()).not.toBeNull();

      const report = yield* world.host().idle();
      expect(report.state).toBe("idle");
      expect(report.fault).toBeNull();
      expect(report.usage).toStrictEqual(turn.usage);
    })
);
