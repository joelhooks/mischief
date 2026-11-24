import { expect, it } from "@effect/vitest";
import type { PeonReport } from "@mischief/core";
import { emptyPeonUsage, fullPeonTemplate, PeonRefused } from "@mischief/core";
import { Clock, Console, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";

import type {
  PeonBox,
  PeonBoxRequest,
  PeonBoxOperation,
} from "../src/peon-box.js";
import { requireSuccess } from "../src/peon-box.js";
import { peonHost } from "../src/peon-host.js";
import type { PeonHostOptions } from "../src/peon-host.js";
import { PeonRequestReceipt, PeonStored } from "../src/peon-state.js";
import type { PeonStoredValue } from "../src/peon-state.js";

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

const fixture = (guardMs = 30_000) => {
  let stored: PeonStoredValue | undefined;
  let alarm: number | null = null;
  let crashOnCompletion = false;
  let nextFault: PeonRefused | undefined;
  let boxState = "idle";
  const results = new Map<string, typeof PeonRequestReceipt.Type>();
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

        if (nextFault !== undefined) {
          const fault = nextFault;
          nextFault = undefined;

          return yield* fault;
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
    guardMs,
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
          readonly value: typeof PeonRequestReceipt.Type;
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
      receipt: (requestId: string) =>
        Effect.suspend(() => {
          const receipt = results.get(requestId);

          return receipt === undefined
            ? Effect.succeed(undefined)
            : Schema.decodeEffect(PeonRequestReceipt)(
                structuredClone(receipt)
              ).pipe(Effect.orDie);
        }),
      load: Effect.suspend(() =>
        stored === undefined
          ? Effect.succeed(undefined)
          : Schema.decodeEffect(PeonStored)(structuredClone(stored)).pipe(
              Effect.orDie
            )
      ),
    },
  };

  return {
    alarm: () => alarm,
    calls,
    crash: () => {
      crashOnCompletion = true;
    },
    fail: (
      fault = new PeonRefused({
        reason: "Box disappeared; inspectPeon before retrying",
      })
    ) => {
      nextFault = fault;
    },
    host: () => peonHost(options),
    read: () => stored,
    replies,
    restoreLegacyPending: () => {
      if (stored?.pending === undefined || stored.pending === null) {
        throw new Error("legacy fixture needs a pending command");
      }

      const pending = { ...stored.pending };
      delete pending.failures;
      delete pending.retryAt;
      stored = { ...stored, pending };
    },
  };
};

const capacityFault = (boxState: "spawned" | "hibernated") =>
  new PeonRefused({
    code: "BoxCapacity",
    boxState,
    reason: "All browser slots are occupied",
  });

it.effect(
  "a coded capacity refusal clears pending and lets the same spawn and resume retry",
  () =>
    Effect.gen(function* capacity() {
      const test = fixture();

      test.fail(capacityFault("spawned"));
      const spawn = () => test.host().initialize(entry, template, false);
      expect((yield* Effect.flip(spawn())).code).toBe("BoxCapacity");
      expect(test.read()?.report.state).toBe("spawned");
      expect(test.read()?.pending).toBeNull();
      expect((yield* spawn()).state).toBe("idle");

      yield* test.host().command("hibernate", "hibernate", "HIBERNATE");
      test.fail(capacityFault("hibernated"));
      const wake = () => test.host().command("resume", "resume", "RESUME");
      expect((yield* Effect.flip(wake())).code).toBe("BoxCapacity");
      expect(test.read()?.report.state).toBe("hibernated");
      expect(test.read()?.pending).toBeNull();
      expect((yield* wake()).state).toBe("idle");
    })
);

it.effect(
  "inspect reconciles the legacy stale resume without replaying it",
  () =>
    Effect.gen(function* legacyStaleResume() {
      const test = fixture();
      yield* test.host().initialize(entry, template, false);
      yield* test.host().command("suspend", "setup-suspend", "SUSPEND");

      const raw = JSON.stringify({
        error: {
          code: "BoxNetworkStale",
          message:
            "A browser box must be attached only to the browser network. Recreate or destroy this browser box before retrying.",
        },
      });

      const call = (requestId: string) =>
        test.host().command("resume", requestId, "RESUME");

      const legacyFault = (body: string) =>
        new PeonRefused({
          reason: `Box ${entry.peonId} resume returned HTTP 409: ${body}. Call inspectPeon before retrying.`,
        });

      test.fail(legacyFault(raw.slice(0, -1)));
      yield* call("legacy-resume").pipe(Effect.flip);
      expect((yield* test.host().inspect).pending).toEqual({
        kind: "resume",
        requestId: "legacy-resume",
      });
      test.fail(legacyFault(raw));
      yield* call("legacy-resume").pipe(Effect.flip);
      test.restoreLegacyPending();

      const parked = yield* test.host().inspectStored;
      expect(parked.fault).toContain("BoxNetworkStale");
      expect(parked).toMatchObject({
        pending: { kind: "resume", requestId: "legacy-resume" },
        state: "suspended",
      });

      const beforeInspect = test.calls.length;

      const settled = {
        fault: null,
        lastSettled: {
          at: yield* Clock.currentTimeMillis,
          code: "BoxNetworkStale",
          kind: "resume",
          requestId: "legacy-resume",
          settledBy: "inspect",
        },
        pending: null,
        state: "suspended",
      };

      expect(yield* test.host().inspect).toMatchObject(settled);
      expect(yield* test.host().inspectStored).toMatchObject(settled);
      expect(
        test.calls.slice(beforeInspect).map(({ operation }) => operation)
      ).toEqual(["inspect"]);
      expect(test.alarm()).toBe(template.hibernateAfter);

      const replay = yield* call("legacy-resume").pipe(Effect.flip);
      expect(replay.code).toBe("BoxNetworkStale");
      expect(test.calls).toHaveLength(beforeInspect + 1);
    })
);

it.effect.prop(
  "retry alarms back off across host restarts and stop after six failed drives",
  { guardMs: Schema.Literals([1000, 30_000, 60_000]) },
  ({ guardMs }) =>
    Effect.gen(function* retryBudget() {
      const test = fixture(guardMs);
      const requestId = "bounded-resume";
      const resume = () => test.host().command("resume", requestId, "RESUME");

      yield* test.host().initialize(entry, template, false);
      yield* test.host().command("suspend", "setup-suspend", "SUSPEND");
      test.fail();
      yield* resume().pipe(Effect.flip);

      for (const multiple of [1, 2, 4, 4, 4]) {
        const delay = multiple * guardMs;
        const now = yield* Clock.currentTimeMillis;
        expect(test.alarm()).toBe(now + delay);

        yield* TestClock.adjust(`${delay - 1} millis`);
        const before = test.calls.length;
        yield* test.host().idle("alarm");
        expect(test.calls).toHaveLength(before);
        expect(test.alarm()).toBe(now + delay);

        yield* TestClock.adjust("1 millis");
        test.fail();
        yield* test.host().idle("alarm");
        expect(test.calls).toHaveLength(before + 1);
      }

      const calls = test.calls.filter(
        ({ operation }) => operation === "resume"
      );

      expect(calls).toHaveLength(6);
      expect(new Set(calls.map(({ body }) => body?.requestId)).size).toBe(1);

      const exhausted = yield* test.host().inspectStored;
      expect(exhausted.fault).toContain("RetryExhausted");
      expect(exhausted).toMatchObject({
        pending: null,
        state: "suspended",
        terminalFault: {
          attempts: 6,
          code: "RetryExhausted",
          kind: "resume",
          requestId,
        },
      });
      expect(test.alarm()).toBe(template.hibernateAfter);

      yield* TestClock.adjust("2 days");
      expect((yield* test.host().idle("alarm")).state).toBe("hibernated");
      expect(
        test.calls.filter(({ operation }) => operation === "resume")
      ).toEqual(calls);

      const resumed = yield* resume();
      expect(resumed.state).toBe("idle");
      expect(resumed).not.toHaveProperty("terminalFault");

      const afterRetry = test.calls.filter(
        ({ operation }) => operation === "resume"
      );

      expect(afterRetry).toHaveLength(7);
      expect(new Set(afterRetry.map(({ body }) => body?.requestId)).size).toBe(
        1
      );
    })
);

it.effect(
  "an exhausted prompt still binds the request ID to its original text after hibernation",
  () =>
    Effect.gen(function* retryPrompt() {
      const test = fixture(1000);
      const requestId = "retryable-prompt";

      const prompt = (text: string) =>
        test.host().command("prompt", requestId, "PROMPT", { text });

      yield* test.host().initialize(entry, template, false);
      test.fail();
      yield* prompt("Original text").pipe(Effect.flip);

      for (const delay of [1, 2, 4, 4, 4]) {
        yield* TestClock.adjust(`${delay} seconds`);
        test.fail();
        yield* test.host().idle("alarm");
      }

      yield* TestClock.adjust("2 days");
      expect((yield* test.host().idle("alarm")).state).toBe("hibernated");

      const before = test.calls.length;
      const conflict = yield* prompt("Different text").pipe(Effect.flip);
      expect(conflict.reason).toContain("different input");
      expect(test.calls).toHaveLength(before);

      expect((yield* prompt("Original text")).lastTurn?.output).toBe(
        turn.output
      );

      const calls = test.calls.filter(
        ({ operation }) => operation === "prompt"
      );

      expect(calls).toHaveLength(7);
      expect(new Set(calls.map(({ body }) => body?.requestId)).size).toBe(1);
    })
);

it.effect.each([401, 403])(
  "a spawn refused with HTTP %s can retry its fixed ID after exhaustion",
  (status) =>
    Effect.gen(function* restartSpawn() {
      const test = fixture(1000);
      const spawn = () => test.host().initialize(entry, template, false);

      const denial = yield* requireSuccess(entry.peonId, "spawn", {
        status,
        text: "Host configuration denied spawn",
      }).pipe(Effect.flip);

      test.fail(denial);
      expect((yield* spawn().pipe(Effect.flip)).code).toBeUndefined();

      for (const delay of [1, 2, 4, 4, 4]) {
        yield* TestClock.adjust(`${delay} seconds`);
        test.fail(denial);
        yield* test.host().idle("alarm");
      }

      const exhausted = yield* test.host().inspectStored;
      expect(exhausted.terminalFault).toMatchObject({
        code: "RetryExhausted",
        attempts: 6,
        httpStatus: status,
        kind: "spawn",
      });
      expect(exhausted.pending).toBeNull();
      expect(test.alarm()).toBeNull();

      const conflict = yield* test
        .host()
        .initialize(
          entry,
          { ...template, hibernateAfter: template.hibernateAfter + 1 },
          false
        )
        .pipe(Effect.flip);

      expect(conflict.reason).toContain("different spawn input");
      expect(
        test.calls.filter(({ operation }) => operation === "spawn")
      ).toHaveLength(6);

      test.fail(denial);
      const refused = yield* spawn().pipe(Effect.flip);
      expect(refused.code).toBeUndefined();
      expect((yield* test.host().inspectStored).pending).toMatchObject({
        kind: "spawn",
        requestId: `spawn/${entry.peonId}`,
      });
      expect(test.alarm()).toBe((yield* Clock.currentTimeMillis) + 1000);

      yield* TestClock.adjust("1 second");
      expect((yield* test.host().idle("alarm")).state).toBe("idle");
      const calls = test.calls.filter(({ operation }) => operation === "spawn");
      expect(calls).toHaveLength(8);
      expect(new Set(calls.map(({ body }) => body?.requestId)).size).toBe(1);
    })
);

it.effect(
  "exhausting automatic suspension leaves no timer that could restart it",
  () =>
    Effect.gen(function* exhaustedSuspend() {
      const test = fixture(1000);
      yield* test.host().initialize(entry, template, false);
      yield* TestClock.adjust("60 seconds");
      test.fail();
      yield* test.host().idle("alarm").pipe(Effect.flip);

      for (const delay of [1, 2, 4, 4, 4]) {
        yield* TestClock.adjust(`${delay} seconds`);
        test.fail();
        yield* test.host().idle("alarm");
      }

      expect((yield* test.host().inspectStored).terminalFault).toMatchObject({
        code: "RetryExhausted",
        kind: "suspend",
      });
      expect(test.alarm()).toBeNull();
      const before = test.calls.length;
      yield* TestClock.adjust("2 days");
      yield* test.host().idle("alarm");
      expect(test.calls).toHaveLength(before);
    })
);

it.effect("alarm logs one structured outcome per actual drive", () =>
  Console.consoleWith((base) => {
    const lines: unknown[] = [];

    return Effect.gen(function* loggedRedrives() {
      const test = fixture();
      const requestId = "log-resume";

      yield* test.host().initialize(entry, template, false);
      yield* test.host().command("suspend", "setup-suspend", "SUSPEND");
      test.fail();
      yield* test
        .host()
        .command("resume", requestId, "RESUME")
        .pipe(Effect.flip);
      yield* test.host().idle("alarm");
      expect(lines).toHaveLength(0);

      yield* TestClock.adjust("30 seconds");
      test.fail(
        yield* requireSuccess(entry.peonId, "resume", {
          status: 503,
          text: JSON.stringify({
            error: { code: "BoxCapacity", message: "Manager unavailable" },
          }),
        }).pipe(Effect.flip)
      );
      yield* test.host().idle("alarm");

      yield* TestClock.adjust("60 seconds");
      test.fail(
        yield* requireSuccess(entry.peonId, "resume", {
          status: 502,
          text: "Gateway lost",
        }).pipe(Effect.flip)
      );
      yield* test.host().idle("alarm");

      yield* TestClock.adjust("120 seconds");
      expect((yield* test.host().idle("alarm")).state).toBe("idle");

      const common = {
        event: "peon_alarm_redrive",
        op: "resume",
        peonId: entry.peonId,
        requestId,
      };

      const records = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.fromJsonString(Schema.Json))
      )(lines);

      expect(records).toEqual([
        {
          ...common,
          attempt: 2,
          code: "BoxCapacity",
          httpStatus: 503,
          outcome: "refused",
        },
        {
          ...common,
          attempt: 3,
          code: "uncoded",
          httpStatus: 502,
          outcome: "refused",
        },
        {
          ...common,
          attempt: 4,
          code: null,
          httpStatus: null,
          outcome: "succeeded",
        },
      ]);
    }).pipe(
      Effect.provideService(
        Console.Console,
        new Proxy(base, {
          get(target, property: keyof Console.Console) {
            return property === "log"
              ? (...args: unknown[]) => lines.push(...args)
              : target[property];
          },
        })
      )
    );
  })
);

it.effect.prop(
  "only permanent uncoded spawn statuses are stamped as immediate rejections",
  {
    status: Schema.Literals([
      400, 401, 403, 404, 408, 409, 413, 418, 422, 425, 429, 500, 503,
    ]),
  },
  ({ status }) =>
    Effect.gen(function* spawnStatus() {
      const response = { status, text: "Uncoded manager failure" };

      const denial = yield* requireSuccess(
        entry.peonId,
        "spawn",
        response
      ).pipe(Effect.flip);

      const other = yield* requireSuccess(
        entry.peonId,
        "resume",
        response
      ).pipe(Effect.flip);

      expect(denial.code).toBe(
        [400, 404, 409, 413, 422].includes(status)
          ? "BoxSpawnRejected"
          : undefined
      );
      expect(denial.httpStatus).toBe(status);
      expect(other.code).toBeUndefined();
    })
);

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
