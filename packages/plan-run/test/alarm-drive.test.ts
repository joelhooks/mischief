// @effect-diagnostics asyncFunction:off -- exercise the Durable Object's Promise and AbortSignal boundaries.
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  CallRegistry,
  Drive,
  EnabledStepKinds,
  Judge,
  Operator,
  ProviderUnavailable,
  RedriveAttempts,
  RunHost,
  RunReportSchema,
  RunStore,
  ThinkAttemptSchema,
  Thinker,
} from "@mischief/core";
import type { RunReport } from "@mischief/core";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { nodeSqlStorage } from "../src/node-sql.js";
import { mailOutboxSql } from "../src/outbox.js";
import { makePlanRun } from "../src/plan-run.js";
import type { PlanRun } from "../src/plan-run.js";
import { runStoreSql } from "../src/sql-store.js";
import type { SqlStorage } from "../src/sql.js";
import { webCrypto } from "../src/web-crypto.js";
import { alarmsFor, call } from "./support.js";
import type { AlarmLog } from "./support.js";

const decodeReport = Schema.decodeUnknownSync(RunReportSchema);

const kinds = Schema.Literals(["think", "judge", "ask", "call"]);

const mix = Schema.Array(kinds).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4)
);

const branch = (name: string, steps: readonly (typeof kinds.Type)[]) => ({
  initial: steps.length === 0 ? "end" : "s0",
  states: {
    ...Object.fromEntries(
      steps.map((kind, index) => {
        const key = `${name}-${index}`;

        const step = {
          ask: { kind, message: key, to: "desk/test", writes: key },
          call: { capability: "echo", input: key, kind, writes: key },
          judge: { kind, question: key },
          think: { kind, prompt: key, writes: key },
        }[kind];

        return [
          `s${index}`,
          {
            meta: { step },
            on: Object.fromEntries(
              {
                ask: ["replied"],
                call: ["done"],
                judge: ["no", "yes"],
                think: ["done"],
              }[kind].map((event) => [
                event,
                {
                  target: index + 1 === steps.length ? "end" : `s${index + 1}`,
                },
              ])
            ),
          },
        ];
      })
    ),
    end: { type: "final" },
  },
});

const planOf = (
  left: readonly (typeof kinds.Type)[],
  right: readonly (typeof kinds.Type)[]
) => ({
  defaults: { agent: { model: "sol", thinking: "low" } },
  envelope: {
    maxAgents: 1 + left.length + right.length,
    maxDepth: 4,
    maxSteps: 80,
    maxThinking: "low",
    models: ["sol"],
    names: ["desk/test"],
    thresholds: { judge: 0.8 },
  },
  goal: "Finish the same work after disconnected callers and interrupted alarms",
  id: "alarm-proof",
  machine: {
    id: "alarm-proof",
    initial: "start",
    states: {
      end: { type: "final" },
      fork: {
        meta: {
          step: {
            branches: {
              left: branch("left", left),
              right: branch("right", right),
            },
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: { done: { target: "end" } },
      },
      start: {
        meta: { step: { kind: "think", prompt: "start", writes: "start" } },
        on: { done: { target: "fork" } },
      },
    },
  },
});

const fileFor = Effect.gen(function* sqliteFile() {
  const fs = yield* FileSystem.FileSystem;

  return (yield* Path.Path).join(
    yield* fs.makeTempDirectoryScoped(),
    "run.sqlite"
  );
});

const servicesOn = (
  storage: SqlStorage,
  thinker: Thinker["Service"],
  cap: number,
  notices: string[]
) =>
  Layer.mergeAll(
    Layer.succeed(Thinker, thinker),
    Layer.succeed(
      Judge,
      Judge.of({
        choose: () =>
          Effect.succeed({ probabilities: { yes: 1 }, usage: { tokens: 0 } }),
      })
    ),
    mailOutboxSql(storage),
    Layer.succeed(
      Operator,
      Operator.of({
        notify: (_runId, question) =>
          Effect.sync(() => {
            notices.push(question.question);
          }),
      })
    ),
    Layer.succeed(EnabledStepKinds, new Set(["call"])),
    Layer.succeed(
      CallRegistry,
      new Map([
        ["echo", { invoke: (input: Schema.Json) => Effect.succeed(input) }],
      ])
    ),
    Layer.succeed(RedriveAttempts, cap)
  );

const hostOn = (
  storage: SqlStorage,
  log: AlarmLog,
  thinker: Thinker["Service"],
  cap = 3,
  notices: string[] = [],
  guardMs = 30_000
) =>
  makePlanRun({
    alarms: alarmsFor(log),
    guardMs,
    services: servicesOn(storage, thinker, cap, notices),
    storage,
  });

const faux = (
  before: (key: string) => Effect.Effect<void> = () => Effect.void
): Thinker["Service"] =>
  Thinker.of({
    decide: () => Effect.die("unused"),
    elaborate: () => Effect.die("unused"),
    think: ({ key, prompt }) =>
      before(key).pipe(Effect.as({ output: `${prompt} thought`, tokens: 2 })),
  });

const alarm = (host: PlanRun, signal?: AbortSignal) =>
  Effect.promise(async (cancel) => {
    await host.alarm(
      signal === undefined ? cancel : AbortSignal.any([signal, cancel])
    );
  });

const inspect = (host: PlanRun) =>
  call(host, "inspectRun", { runId: "run" }).pipe(
    Effect.map(({ body }) => decodeReport(body))
  );

const finish = (host: PlanRun) =>
  Effect.gen(function* finishViaAlarms() {
    for (let turn = 0; turn < 30; turn += 1) {
      yield* alarm(host);
      const report = yield* inspect(host);

      if (report.status === "running") {
        continue;
      }

      if (report.status !== "waiting-for-reply") {
        return report;
      }

      for (const awaiting of report.awaiting ?? []) {
        const result = yield* call(host, "deliverReply", {
          body: `reply:${awaiting.key}`,
          from: awaiting.to,
          replyTo: awaiting.messageId,
        });

        expect(result.status).toBe(200);
      }
    }

    return yield* Effect.die("alarm model did not settle");
  });

const inlineEnd = (plan: Schema.Json) =>
  Effect.gen(function* oldRequestPath() {
    const storage = nodeSqlStorage(yield* fileFor);

    const host = yield* RunHost.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          servicesOn(storage, faux(), Number.MAX_SAFE_INTEGER, []),
          Drive.inline,
          Layer.effect(RunStore, runStoreSql(storage)),
          webCrypto
        )
      )
    );

    let report = yield* host.submit("run", plan);

    for (
      let turn = 0;
      report.status === "waiting-for-reply" && turn < 30;
      turn += 1
    ) {
      for (const awaiting of report.awaiting ?? []) {
        report = yield* host.deliver({
          body: `reply:${awaiting.key}`,
          from: awaiting.to,
          replyTo: awaiting.messageId,
        });
      }
    }

    return report;
  });

const end = ({ docs, status, transitions, value }: RunReport) => ({
  docs,
  status,
  transitions,
  value,
});

it.live.prop(
  "stored commands plus alarms reach the inline model's end and docs across store/drive crashes",
  {
    crashAt: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 }))
    ),
    cuts: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 2, minimum: 1 }))
    ),
    left: Arbitrary.schema(mix),
    right: Arbitrary.schema(mix),
  },
  ({ crashAt, cuts, left, right }) =>
    Effect.gen(function* equivalence() {
      const plan = planOf(left, right);
      const expected = yield* inlineEnd(plan);

      const file = yield* fileFor;
      const log: AlarmLog = { pending: null, sets: 0 };
      let host = hostOn(nodeSqlStorage(file), log, faux());

      const submitted = decodeReport(
        (yield* call(host, "submitPlan", { plan, runId: "run" })).body
      );

      expect(submitted.status).toBe("running");
      expect(log.pending).not.toBeNull();
      expect(log.pending).toBeLessThanOrEqual(yield* Clock.currentTimeMillis);

      for (let cut = 0; cut < cuts; cut += 1) {
        const reached = yield* Deferred.make<boolean>();
        let starts = 0;
        host = hostOn(
          nodeSqlStorage(file),
          log,
          faux(() =>
            Effect.gen(function* interruptAt() {
              starts += 1;

              if (starts === crashAt) {
                yield* Deferred.succeed(reached, true);

                return yield* Effect.never;
              }

              return yield* Effect.void;
            })
          )
        );
        const controller = new AbortController();

        const driving = yield* alarm(host, controller.signal).pipe(
          Effect.ignoreCause,
          Effect.forkScoped
        );

        const stopped = yield* Effect.raceFirst(
          Deferred.await(reached).pipe(Effect.as(true)),
          Fiber.join(driving).pipe(Effect.as(false))
        );

        if (!stopped) {
          break;
        }

        expect(log.pending).not.toBeNull();
        controller.abort();
        yield* Fiber.join(driving);
      }

      host = hostOn(nodeSqlStorage(file), log, faux());
      const actual = yield* finish(host);
      expect(end(actual)).toEqual(end(expected));
      expect(log.pending).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 35 }, timeout: 120_000 }
);

it.live.prop(
  "submit returns before a think and committed reads return during a suspended alarm drive",
  { seed: Arbitrary.schema(Schema.String) },
  ({ seed }) =>
    Effect.gen(function* nonblocking() {
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const log: AlarmLog = { pending: null, sets: 0 };

      const host = hostOn(
        nodeSqlStorage(yield* fileFor),
        log,
        faux(() =>
          Deferred.succeed(entered, true).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.asVoid
          )
        )
      );

      const controller = new AbortController();

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          controller.abort();
        })
      );

      const request = new Request("http://plan-run/submitPlan", {
        body: JSON.stringify({
          docs: { seed },
          plan: planOf([], []),
          runId: "run",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });

      const stored = yield* Effect.promise(
        async () => await host.fetch(request)
      ).pipe(Effect.timeout("1 second"));

      expect(stored.status).toBe(200);
      expect(yield* Deferred.isDone(entered)).toBe(false);
      controller.abort();

      expect(
        decodeReport((yield* call(host, "pauseRun", { runId: "run" })).body)
          .status
      ).toBe("paused");
      yield* alarm(host);
      expect((yield* inspect(host)).status).toBe("paused");
      expect(yield* Deferred.isDone(entered)).toBe(false);
      expect(
        decodeReport((yield* call(host, "resumeRun", { runId: "run" })).body)
          .status
      ).toBe("running");
      expect(yield* Deferred.isDone(entered)).toBe(false);

      const driving = yield* alarm(host).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const { pending } = log;
      const seen = yield* inspect(host).pipe(Effect.timeout("1 second"));

      const record = yield* call(host, "readRun", { runId: "run" }).pipe(
        Effect.timeout("1 second")
      );

      expect(seen.status).toBe("running");
      expect(seen.docs).toEqual({ seed });
      expect(record.status).toBe(200);
      expect(log.pending).toBe(pending);
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(driving);
      expect((yield* inspect(host)).status).toBe("done");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 10 }, timeout: 30_000 }
);

it.live.prop(
  "unfinished thinks are durably attempted exactly the cap, then fail loudly and escalate once",
  {
    cap: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 }))
    ),
    interleaveOutages: Arbitrary.schema(Schema.Boolean),
  },
  ({ cap, interleaveOutages }) =>
    Effect.gen(function* exhausted() {
      const file = yield* fileFor;
      const log: AlarmLog = { pending: null, sets: 0 };
      const notices: string[] = [];
      const counts = { calls: 0, outages: 0 };

      const unavailable = Thinker.of({
        ...faux(),
        think: ({ key }) =>
          Effect.sync(() => {
            counts.calls += 1;
            counts.outages += 1;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ProviderUnavailable({
                  cause: "busy",
                  key,
                  provider: "faux",
                  status: 429,
                })
              )
            )
          ),
      });

      let host = hostOn(nodeSqlStorage(file), log, faux(), cap, notices);
      yield* call(host, "submitPlan", { plan: planOf([], []), runId: "run" });

      for (let index = 0; index < cap; index += 1) {
        const entered = yield* Deferred.make<boolean>();
        host = hostOn(
          nodeSqlStorage(file),
          log,
          faux(() =>
            Effect.gen(function* neverFinish() {
              counts.calls += 1;
              yield* Deferred.succeed(entered, true);

              return yield* Effect.never;
            })
          ),
          cap,
          notices
        );
        const controller = new AbortController();

        const driving = yield* alarm(host, controller.signal).pipe(
          Effect.ignoreCause,
          Effect.forkScoped
        );

        yield* Deferred.await(entered);
        controller.abort();
        yield* Fiber.join(driving);

        if (interleaveOutages && index + 1 < cap) {
          host = hostOn(nodeSqlStorage(file), log, unavailable, cap, notices);
          yield* alarm(host);
          expect((yield* inspect(host)).status).toBe("waiting-for-provider");
          yield* call(host, "resumeRun", { runId: "run" });
        }
      }

      host = hostOn(
        nodeSqlStorage(file),
        log,
        faux(() =>
          Effect.sync(() => {
            counts.calls += 1;
          })
        ),
        cap,
        notices
      );
      yield* alarm(host);
      yield* alarm(host);
      const report = yield* inspect(host);
      const record = yield* call(host, "readRun", { runId: "run" });

      const { journal } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          journal: Schema.Array(
            Schema.Struct({ entry: Schema.Json, key: Schema.String })
          ),
        })
      )(record.body);

      const attempts = journal
        .filter(({ key }) => key.startsWith("think-attempt:"))
        .map(({ entry }) =>
          Schema.decodeUnknownSync(ThinkAttemptSchema)(entry)
        );

      expect(counts.calls).toBe(cap + counts.outages);
      expect(attempts).toEqual([
        {
          attempts: cap + counts.outages,
          level: "low",
          model: "sol",
          pending: false,
          unfinished: cap,
        },
      ]);
      expect(report.status).toBe("failed");
      expect(report.thinking).toBeUndefined();
      expect(report.failures?.[0]?.reason).toContain(
        `was cut before finishing on ${cap} attempts`
      );
      expect(report.failures?.[0]?.reason).toContain(
        "smaller input or a lower thinking level"
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]).toBe(report.failures?.[0]?.reason);
      expect(log.pending).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 15 }, timeout: 60_000 }
);

it.live("a later alarm retires an expired abandoned drive before writing", () =>
  Effect.gen(function* abandoned() {
    const entered = yield* Deferred.make<boolean>();
    let starts = 0;
    const log: AlarmLog = { pending: null, sets: 0 };

    const storage = nodeSqlStorage(yield* fileFor);

    const host = hostOn(
      storage,
      log,
      faux(() =>
        Effect.gen(function* once() {
          starts += 1;

          if (starts === 1) {
            yield* Deferred.succeed(entered, true);

            return yield* Effect.never;
          }

          return yield* Effect.void;
        })
      )
    );

    yield* call(host, "submitPlan", { plan: planOf([], []), runId: "run" });

    const abandonedDrive = yield* alarm(host).pipe(
      Effect.ignoreCause,
      Effect.forkScoped
    );

    yield* Deferred.await(entered);
    expect((yield* inspect(host)).status).toBe("running");
    storage.sql.exec("UPDATE mischief_drive_lease SET lease_until = 0");
    yield* alarm(host).pipe(Effect.timeout("1 second"));
    yield* Fiber.join(abandonedDrive);
    expect(starts).toBe(2);
    expect((yield* inspect(host)).status).toBe("done");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live.prop(
  "two alarm runtimes share a durable renewable lease and a live non-holder never counts a think attempt",
  {
    holdMillis: Arbitrary.schema(Schema.Literals([1200, 1800])),
  },
  ({ holdMillis }) =>
    Effect.gen(function* twoDrivers() {
      const file = yield* fileFor;
      const log: AlarmLog = { pending: null, sets: 0 };
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const counts = { calls: 0 };

      const thinker = faux(() =>
        Effect.gen(function* blockedThink() {
          counts.calls += 1;
          yield* Deferred.succeed(entered, true);
          yield* Deferred.await(release);
        })
      );

      const first = hostOn(nodeSqlStorage(file), log, thinker, 3, [], 1000);
      const second = hostOn(nodeSqlStorage(file), log, thinker, 3, [], 1000);
      yield* call(first, "submitPlan", { plan: planOf([], []), runId: "run" });
      const active = yield* alarm(first).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const before = yield* inspect(second);
      expect(before.driveLease?.holder).toBeTypeOf("string");
      expect(before.driveLease?.epoch).toBeGreaterThan(0);
      yield* Effect.sleep(holdMillis);
      yield* alarm(second).pipe(Effect.timeout("1 second"));
      const held = yield* inspect(second);
      expect(held.driveLease?.epoch).toBe(before.driveLease?.epoch);
      expect(held.driveLease?.holder).toBe(before.driveLease?.holder);
      expect(held.driveLease?.leaseUntil).toBeGreaterThan(
        before.driveLease?.leaseUntil ?? 0
      );
      expect(counts.calls).toBe(1);
      const record = yield* call(second, "readRun", { runId: "run" });

      const { journal } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          journal: Schema.Array(
            Schema.Struct({ entry: Schema.Json, key: Schema.String })
          ),
        })
      )(record.body);

      const attempts = journal
        .filter(({ key }) => key.startsWith("think-attempt:"))
        .map(({ entry }) =>
          Schema.decodeUnknownSync(ThinkAttemptSchema)(entry)
        );

      expect(attempts).toEqual([
        {
          attempts: 1,
          level: "low",
          model: "sol",
          pending: true,
          unfinished: 0,
        },
      ]);
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(active);
      yield* alarm(second);
      expect((yield* inspect(second)).status).toBe("done");
      expect(counts.calls).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 }, timeout: 30_000 }
);

it.live.prop(
  "resubmitting a run mid-think never starts a second drive or charges a second think, the same body reports the stored run, and a different body is refused",
  {
    resubmits: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
  },
  ({ resubmits }) =>
    Effect.gen(function* doubleSubmit() {
      const file = yield* fileFor;
      const log: AlarmLog = { pending: null, sets: 0 };
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const counts = { calls: 0 };

      const thinker = faux(() =>
        Effect.gen(function* blockedThink() {
          counts.calls += 1;
          yield* Deferred.succeed(entered, true);
          yield* Deferred.await(release);
        })
      );

      const first = hostOn(nodeSqlStorage(file), log, thinker, 3, [], 1000);
      const second = hostOn(nodeSqlStorage(file), log, thinker, 3, [], 1000);
      const body = { docs: { brief: "b" }, plan: planOf([], []), runId: "run" };
      yield* call(first, "submitPlan", body);
      const active = yield* alarm(first).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);

      for (let index = 0; index < resubmits; index += 1) {
        const again = yield* call(second, "submitPlan", body).pipe(
          Effect.timeout("1 second")
        );

        expect(again.status).toBe(200);
        expect(decodeReport(again.body).status).toBe("running");
        yield* alarm(second).pipe(Effect.timeout("1 second"));
      }

      const changed = yield* call(second, "submitPlan", {
        ...body,
        docs: { brief: "another brief" },
      }).pipe(Effect.timeout("1 second"));

      expect(changed.status).not.toBe(200);
      expect(JSON.stringify(changed.body)).toContain("reviseRun");
      expect(counts.calls).toBe(1);

      yield* Deferred.succeed(release, true);
      yield* Fiber.join(active);
      yield* alarm(second);
      const done = yield* call(second, "submitPlan", body);
      expect(decodeReport(done.body).status).toBe("done");
      expect(counts.calls).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 30_000 }
);
