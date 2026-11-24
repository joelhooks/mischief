import { expect, it } from "@effect/vitest";
import type { WatchDefinition } from "@mischief/core";
import { Clock, Effect, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import { reserveWatchWake } from "../src/watch-budget.js";
import { checkHttp } from "../src/watch-check.js";
import type { CheckResult } from "../src/watch-check.js";
import { watchEngine } from "../src/watch-engine.js";
import type { Checkpoint, Delivery } from "../src/watch-machine.js";

const owner = "did:web:watch-test.pi.ratking-fleet.invalid";

const watchId = `watch-${"a".repeat(64)}`;

const definition: typeof WatchDefinition.Type = {
  condition: { expect: { state: "idle" }, peonId: "example", type: "peon" },
  intervalSeconds: 60,
  kind: "repeat",
  label: "Example watch",
  message: { body: "The build is ready.", summary: "Ready" },
  notify: { cc: [], to: ["example/desk"] },
  timeoutSeconds: 24 * 60 * 60,
};

const observed = (cursor: string): CheckResult => ({
  cursor,
  detail: "matched",
  evidence: "Example evidence",
  outcome: "true",
});

const dayMs = 86_400_000;

const alwaysAccept: (
  delivery: Delivery
) => "accepted" | "refused" | "uncertain" = () => "accepted";

const makeWorld = (
  usedInitially: readonly string[] = [],
  usedTomorrow: readonly string[] = []
) => {
  let record: Checkpoint | undefined;
  const cursors = new Set<string>();
  const sent: { readonly delivery: Delivery; readonly envelope: string }[] = [];
  const sealed: string[] = [];

  const budget = new Map([
    ["0/example/desk", usedInitially],
    ["1/example/desk", usedTomorrow],
  ]);

  const attempts: number[] = [];

  let sendOutcome = alwaysAccept;

  let checks = 0;
  let result: CheckResult = { detail: "not ready", outcome: "false" };
  let cut: "seal" | "send" | null = null;
  const crash = Effect.die("simulated power loss");

  const boot = () =>
    watchEngine({
      load: Effect.sync(() => record),
      save: (checkpoint) =>
        Effect.sync(() => {
          record = checkpoint;

          if (checkpoint.pending !== null) {
            cursors.add(checkpoint.pending.firing.cursor);
          }
        }),
      seen: (cursor) => Effect.sync(() => cursors.has(cursor)),
      check: () =>
        Effect.sync(() => {
          checks += 1;

          return result;
        }),
      reserve: (name, at, key) =>
        Effect.sync(() => {
          const day = `${Math.floor(at / dayMs)}/${name}`;
          const proposed = reserveWatchWake(budget.get(day) ?? [], key);
          budget.set(day, proposed.used);

          return proposed.allowed;
        }),
      seal: (delivery, _watch, text) =>
        Effect.suspend(() => {
          if (cut === "seal") {
            cut = null;

            return crash;
          }

          const envelope = JSON.stringify([delivery.name, text, sealed.length]);
          sealed.push(envelope);

          return Effect.succeed(envelope);
        }),
      send: (delivery, envelope) =>
        Effect.gen(function* send() {
          attempts.push(yield* Clock.currentTimeMillis);
          sent.push({ delivery, envelope });

          if (cut === "send") {
            cut = null;

            return yield* crash;
          }

          return sendOutcome(delivery);
        }),
    });

  let engine = boot();

  return {
    arm: (
      kind: "once" | "repeat" = "repeat",
      overrides: Partial<typeof definition> = {}
    ) =>
      Effect.suspend(() =>
        engine.arm(watchId, owner, { ...definition, kind, ...overrides })
      ),
    attempts,
    nextAt: () => record?.nextAt,
    outcome: (send: typeof sendOutcome) => {
      sendOutcome = send;
    },
    checks: () => checks,
    cut: (stage: typeof cut) => {
      cut = stage;
    },
    inspect: Effect.suspend(() => engine.inspect(owner)),
    reboot: () => {
      engine = boot();
    },
    sealed,
    sent,
    stop: (caller: string, state: "done" | "cancelled") =>
      Effect.suspend(() => engine.stop(caller, state)),
    tick: (next: CheckResult, missed = 0) =>
      Effect.gen(function* tick() {
        if (record?.nextAt === null || record === undefined) {
          return yield* Effect.die("No watch alarm was set");
        }

        result = next;
        yield* TestClock.setTime(record.nextAt + missed * 60_000);
        yield* engine.alarm;

        return yield* engine.inspect(owner);
      }),
  };
};

it.effect(
  "a once watch waits through false and checkError, then fires exactly once on true",
  () =>
    Effect.gen(function* onceAfterTrue() {
      const world = makeWorld();
      yield* world.arm("once");
      expect(
        (yield* world.tick({ detail: "not ready", outcome: "false" })).watch
          .state
      ).toBe("armed");
      expect(
        (yield* world.tick({ detail: "server failure", outcome: "checkError" }))
          .lastCheck?.outcome
      ).toBe("checkError");
      expect(world.sent).toHaveLength(0);
      const fired = yield* world.tick(observed("first"));
      expect(fired.watch.state).toBe("done");
      expect(fired.firings).toHaveLength(1);
      expect(world.sent).toHaveLength(1);
    })
);

it.effect.prop(
  "a repeat watch consumes each cursor once, even with missed ticks and restarts",
  {
    choices: Arbitrary.schema(
      Schema.Array(
        Schema.Literals(["first", "second", "third", "false", "error"])
      ).check(Schema.isMinLength(1), Schema.isMaxLength(12))
    ),
  },
  ({ choices }) =>
    Effect.gen(function* matchesCursorModel() {
      const world = makeWorld();
      const model = new Set<string>();
      yield* world.arm();

      for (const choice of choices) {
        world.reboot();

        if (choice === "false") {
          yield* world.tick({ detail: "not ready", outcome: "false" }, 2);
        } else if (choice === "error") {
          yield* world.tick(
            { detail: "server failure", outcome: "checkError" },
            2
          );
        } else {
          yield* world.tick(observed(choice), 2);
          model.add(choice);
        }
      }

      const inspected = yield* world.inspect;
      expect(world.checks()).toBe(choices.length);
      expect(world.sent).toHaveLength(model.size);
      expect(inspected.firings.map(({ cursor }) => cursor)).toEqual([...model]);
    })
);

it.effect(
  "an alarm resumes fired intent before sealing and resends identical bytes after an uncertain send",
  () =>
    Effect.gen(function* preservesEnvelope() {
      const world = makeWorld();
      yield* world.arm("once");
      world.cut("seal");
      yield* world.tick(observed("result")).pipe(Effect.exit);
      const pending = yield* world.inspect;
      expect(pending.watch.state).toBe("fired");
      expect(world.sent).toHaveLength(0);
      world.reboot();
      world.cut("send");
      yield* world.tick(observed("unused")).pipe(Effect.exit);
      expect(world.sent).toHaveLength(1);
      world.reboot();
      const done = yield* world.tick(observed("still unused"));
      expect(done.firings).toEqual(pending.firings);
      expect(done.watch.state).toBe("done");
      expect(world.checks()).toBe(1);
      expect(world.sealed).toHaveLength(1);
      expect(world.sent.map(({ envelope }) => envelope)).toEqual([
        world.sealed[0],
        world.sealed[0],
      ]);
    })
);

it.effect(
  "the 21st wake becomes cc and sends the owner a separate quiet notice",
  () =>
    Effect.gen(function* downgradesWake() {
      const world = makeWorld(
        Array.from({ length: 19 }, (_, index) => `prior-${index}`)
      );

      yield* world.arm();
      yield* world.tick(observed("twentieth"));
      const receipt = yield* world.tick(observed("twenty-first"));
      expect(
        world.sent.map(({ delivery: { name, wake } }) => [name, wake])
      ).toEqual([
        ["example/desk", true],
        ["example/desk", false],
        ["watch-test", false],
      ]);
      expect(receipt.firings.at(-1)?.downgraded).toEqual(["example/desk"]);
    })
);

it.effect(
  "an uncertain send retried on a full UTC day becomes quiet without resealing",
  () =>
    Effect.gen(function* chargesRetryDay() {
      const world = makeWorld(
        [],
        Array.from({ length: 20 }, (_, index) => `day-one-${index}`)
      );

      yield* TestClock.setTime(dayMs - 60_000 - 5000);
      yield* world.arm();
      world.cut("send");
      yield* world.tick(observed("ready")).pipe(Effect.exit);
      world.reboot();
      const receipt = yield* world.tick(observed("unused"));
      expect(
        world.sent.map(({ delivery }) => [delivery.name, delivery.wake])
      ).toEqual([
        ["example/desk", true],
        ["example/desk", false],
        ["watch-test", false],
      ]);
      expect(world.sent[0]?.envelope).toBe(world.sent[1]?.envelope);
      expect(receipt.firings[0]?.downgraded).toEqual(["example/desk"]);
    })
);

it.effect(
  "two completed GitHub runs with the same check name fire separately",
  () =>
    Effect.gen(function* githubRunCursors() {
      const url = "https://checks.example.invalid/status";

      const condition = {
        type: "http",
        url,
        expect: {
          jsonPath: '$.check_runs[?(@.name=="ci")].status',
          equals: "completed",
        },
      } as const;

      const world = makeWorld();
      yield* world.arm();

      for (const id of [501, 502, 501]) {
        const get = vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            check_runs: [
              {
                id,
                name: "ci",
                status: "completed",
                head_sha: "a".repeat(40),
                conclusion: "success",
                completed_at: "2026-11-23T22:00:00Z",
              },
            ],
          })
        );

        const result = yield* checkHttp(
          condition,
          "checks.example.invalid",
          get
        );

        expect(result.outcome).toBe("true");
        yield* world.tick(result);
      }

      const { firings } = yield* world.inspect;
      expect(firings).toHaveLength(2);
      expect(firings[0]?.cursor).not.toBe(firings[1]?.cursor);
    })
);

it.effect(
  "expiry stops retrying uncertain mail, keeps refusals, and sends one quiet owner notice",
  () =>
    Effect.gen(function* expiresBeforeRetry() {
      const world = makeWorld();
      world.outcome(({ name, ownerNotice }) => {
        if (ownerNotice) {
          return "accepted";
        }

        return name === "example/desk" ? "refused" : "uncertain";
      });
      yield* world.arm("once", {
        timeoutSeconds: 66,
        notify: { to: ["example/desk", "another/desk"], cc: [] },
      });
      yield* world.tick(observed("ready"));
      yield* world.tick(observed("unused"));
      const receipt = yield* world.tick(observed("unused"));
      expect(receipt.watch.state).toBe("expired");
      expect(receipt.firings[0]?.undelivered).toEqual([
        "example/desk",
        "another/desk",
      ]);
      expect(world.nextAt()).toBeNull();
      expect(
        world.sent.map(({ delivery }) => [delivery.name, delivery.wake])
      ).toEqual([
        ["example/desk", true],
        ["another/desk", true],
        ["another/desk", true],
        ["watch-test", false],
      ]);
    })
);

it.effect(
  "uncertain deliveries get five retries with exponential backoff",
  () =>
    Effect.gen(function* retriesAreBounded() {
      const world = makeWorld();
      world.outcome(() => "uncertain");
      yield* world.arm("once");

      for (let attempt = 0; attempt < 6; attempt += 1) {
        yield* world.tick(observed("ready"));
      }

      expect(world.attempts).toEqual([
        60_000, 65_000, 75_000, 95_000, 135_000, 215_000,
      ]);
      expect(world.nextAt()).toBeNull();
      expect((yield* world.inspect).firings[0]?.undelivered).toEqual([
        "example/desk",
      ]);
      expect(new Set(world.sent.map(({ envelope }) => envelope)).size).toBe(1);
    })
);

it.effect("a non-owner cannot cancel or complete an armed watch", () =>
  Effect.gen(function* refusesForeignStop() {
    const world = makeWorld();
    yield* world.arm();

    for (const state of ["cancelled", "done"] as const) {
      const result = yield* world
        .stop("did:web:foreign.invalid", state)
        .pipe(Effect.result);

      expect(Result.getFailure(result)).toMatchObject({
        value: { code: "NotOwner" },
      });
    }

    expect((yield* world.inspect).watch.state).toBe("armed");
  })
);
