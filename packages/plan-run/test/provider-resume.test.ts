import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Judge,
  Mail,
  Operator,
  ProviderResume,
  ProviderUnavailable,
  RunStateSchema,
  Thinker,
} from "@mischief/core";
import {
  Clock,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Random,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";

import { nodeSqlStorage } from "../src/node-sql.js";
import { makePlanRun } from "../src/plan-run.js";
import { alarmsFor, callAndDrive as call, decodeReport } from "./support.js";
import type { AlarmLog } from "./support.js";

const plan = {
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: 1,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Resume after the model proxy recovers",
  id: "draft",
  machine: {
    id: "draft",
    initial: "draft",
    states: {
      done: { type: "final" },
      draft: {
        meta: { step: { kind: "think", prompt: "draft", writes: "draft" } },
        on: { done: { target: "done" } },
      },
    },
  },
};

const decodeState = Schema.decodeUnknownSync(
  Schema.fromJsonString(RunStateSchema)
);

it.effect.prop(
  "the real SQLite host keeps the resume alarm across replacement, ignores early and redelivered alarms, retains cap mail's journal, and still permits a manual resume",
  {
    failAlarm: Schema.Boolean,
    failures: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })),
    limit: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
    pause: Schema.Boolean,
  },
  ({ failAlarm, failures, limit, pause }) =>
    Effect.gen(function* durableWake() {
      const fs = yield* FileSystem.FileSystem;

      const file = (yield* Path.Path).join(
        yield* fs.makeTempDirectoryScoped(),
        "run.sqlite"
      );

      const storage = nodeSqlStorage(file);
      const alarms: AlarmLog = { pending: null, sets: 0 };
      const world = { calls: 0, failAlarm, mails: 0, recover: false };
      const clock = yield* Clock.Clock;

      yield* TestClock.setTime(0);

      const policy = { attempts: limit, baseMs: 100, capMs: 400 };

      const services = Layer.mergeAll(
        Judge.unwired,
        Mail.unwired,
        Layer.succeed(Clock.Clock, clock),
        Layer.succeed(Random.Random, {
          nextDoubleUnsafe: () => 0.5,
          nextIntUnsafe: () => 1,
        }),
        Layer.succeed(ProviderResume, policy),
        Layer.succeed(
          Operator,
          Operator.of({
            holdAlarm: () =>
              Effect.suspend(() => {
                if (world.failAlarm) {
                  world.failAlarm = false;

                  return Effect.fail("the mailbox is temporarily unavailable");
                }

                return Effect.sync(() => {
                  world.mails += 1;
                });
              }),
            notify: () => Effect.void,
          })
        ),
        Layer.succeed(
          Thinker,
          Thinker.of({
            decide: () => Effect.die("unused"),
            elaborate: () => Effect.die("unused"),
            think: ({ key }) =>
              Effect.gen(function* proxyCall() {
                world.calls += 1;

                if (world.recover || world.calls > failures) {
                  return { output: "drafted", tokens: 1 };
                }

                return yield* new ProviderUnavailable({
                  cause: "busy",
                  error: "model proxy busy",
                  key,
                  provider: "proxy/sol",
                  retryAfter: (yield* Clock.currentTimeMillis) + 1000,
                  status: 429,
                });
              }),
          })
        )
      );

      const hostNow = () =>
        makePlanRun({
          alarms: alarmsFor(alarms),
          guardMs: 30,
          services,
          storage,
        });

      const stateNow = () =>
        decodeState(
          storage.sql
            .exec("SELECT state FROM mischief_runs WHERE run_id = ?", "held")
            .toArray()[0]?.state
        );

      const host = hostNow();
      const wake = () => Effect.promise(hostNow().alarm);

      expect(
        decodeReport(
          (yield* call(host, "submitPlan", { plan, runId: "held" })).body
        ).status
      ).toBe("waiting-for-provider");

      for (let attempt = 0; attempt < limit; attempt += 1) {
        const state = stateNow();
        const at = state.held[0]?.resumeAfter;

        if (state.status === "done") {
          expect(alarms.pending).toBeNull();

          break;
        }

        expect(at).not.toBeNull();

        const due = Option.getOrThrow(Option.fromNullishOr(at));

        expect(alarms.pending).toBe(due);
        yield* TestClock.setTime(due - 1);

        const before = world.calls;

        yield* wake();

        expect(world.calls).toBe(before);
        expect(stateNow()).toStrictEqual(state);
        expect(alarms.pending).toBe(at);

        yield* TestClock.setTime(due);
        yield* wake();

        expect(world.calls).toBe(before + 1);
        expect(stateNow().resumeAttempts).toBe(attempt + 1);
      }

      if (failAlarm && failures > limit) {
        const pending = Option.getOrThrow(Option.fromNullishOr(alarms.pending));
        const before = world.calls;

        expect(world.mails).toBe(0);
        expect(
          storage.sql
            .exec(
              "SELECT entry FROM mischief_journal WHERE run_id = ? AND key = ?",
              "held",
              "done:hold-alarm"
            )
            .toArray()
        ).toHaveLength(0);
        yield* TestClock.setTime(pending);
        yield* wake();

        expect(world.calls).toBe(before);
      }

      const capped = stateNow();
      const { calls, mails } = world;

      expect(alarms.pending).toBeNull();
      expect(capped.status).toBe(
        failures > limit ? "waiting-for-provider" : "done"
      );
      expect(mails).toBe(failures > limit ? 1 : 0);

      if (mails > 0) {
        expect(
          storage.sql
            .exec(
              "SELECT entry FROM mischief_journal WHERE run_id = ? AND key = ?",
              "held",
              "done:hold-alarm"
            )
            .toArray()
        ).toHaveLength(1);
      }

      for (let repeat = 0; repeat < 3; repeat += 1) {
        yield* wake();
      }

      expect(world.calls).toBe(calls);
      expect(world.mails).toBe(mails);
      expect(stateNow()).toStrictEqual(capped);

      world.recover = true;

      expect(
        decodeReport((yield* call(host, "resumeRun", { runId: "held" })).body)
          .status
      ).toBe("done");
      expect(stateNow().resumeAttempts).toBe(capped.resumeAttempts);

      if (pause) {
        world.recover = false;
        world.calls = 0;
        yield* call(host, "submitPlan", { plan, runId: "paused" });
        yield* call(host, "pauseRun", { runId: "paused" });

        expect(alarms.pending).toBeNull();
        yield* TestClock.setTime(1_000_000);

        const before = world.calls;

        yield* wake();

        expect(world.calls).toBe(before);
        world.recover = true;
        expect(
          decodeReport(
            (yield* call(host, "resumeRun", { runId: "paused" })).body
          ).status
        ).toBe("done");
      }

      world.recover = false;
      world.calls = 0;
      world.failAlarm = false;
      yield* call(host, "submitPlan", { plan, runId: "disabled" });

      expect(alarms.pending).not.toBeNull();
      policy.attempts = 0;
      yield* wake();

      expect(world.calls).toBe(1);
      expect(alarms.pending).toBeNull();
      yield* TestClock.setTime(2_000_000);
      yield* wake();

      expect(world.calls).toBe(1);
      expect(alarms.pending).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 25 }, timeout: 120_000 }
);
