// @effect-diagnostics asyncFunction:off -- esbuild and the killed client exercise native Promise/process boundaries.
// @effect-diagnostics nodeBuiltinImport:off -- the seam kills a real submitting client with SIGKILL; the process wrapper does not expose that signal.
import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  CallRegistry,
  EnabledStepKinds,
  Judge,
  Operator,
  RunReportSchema,
  ScheduleNotices,
  ScheduleReportSchema,
  Thinker,
  WakeRuns,
} from "@mischief/core";
import type { RunReport } from "@mischief/core";
import { makePlanRun, makeSchedule } from "@mischief/plan-run";
import type { PlanRun, ScheduleObject, SqlStorage } from "@mischief/plan-run";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import {
  Clock,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { FetchHttpClient } from "effect/http";
import { build } from "esbuild";

import { postboxMail, rememberObject } from "../src/postbox-mail.js";
import {
  cutAt,
  cutEffect,
  frozenAfterCut,
  neverCut,
  reaches,
} from "./alarm-cut.js";
import type { AlarmClock, Cut } from "./alarm-cut.js";
import { bearer, kill, postStored, prepare, start } from "./workerd.js";

const plan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 1,
    maxDepth: 2,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "A killed client does not own execution",
  id: "alarm-client",
  machine: {
    id: "alarm-client",
    initial: "think",
    states: {
      end: { type: "final" },
      think: {
        meta: { step: { kind: "think", prompt: "work", writes: "work" } },
        on: { done: { target: "end" } },
      },
    },
  },
};

const Journal = Schema.Struct({
  journal: Schema.Array(
    Schema.Struct({ entry: Schema.Json, key: Schema.String })
  ),
});

const Report = Schema.Struct({
  docs: Schema.Record(Schema.String, Schema.Json),
  status: Schema.String,
});

const decodeReport = Schema.decodeUnknownSync(Report);

const decodeJournal = Schema.decodeUnknownSync(Journal);

const pendingAttempt = Schema.is(
  Schema.Struct({ pending: Schema.Literal(true) })
);

const decodeStored = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ status: Schema.String }))
);

const clientScript = `import { readFileSync } from "node:fs";
const { body, headers, url } = JSON.parse(readFileSync(0, "utf8"));
const response = await fetch(url, { body, headers, method: "POST" });
process.stdout.write((await response.text()) + "\\n");
setInterval(() => {}, 1000);
`;

it.live(
  "workerd finishes from the alarm after the submitting client is killed mid-think",
  () =>
    Effect.gen(function* killedClient() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const bundle = path.join(
        yield* fs.makeTempDirectoryScoped(),
        "alarm-worker.js"
      );

      yield* Effect.tryPromise(
        async () =>
          await build({
            bundle: true,
            conditions: ["workerd", "worker", "browser", "import"],
            define: {
              __BUNDLE_COMMIT__: JSON.stringify("fixture"),
              __BUNDLE_VERSION__: JSON.stringify("fixture"),
            },
            entryPoints: [
              path.resolve(import.meta.dirname, "fixtures/alarm-worker.ts"),
            ],
            external: ["cloudflare:*"],
            format: "esm",
            mainFields: ["module", "main"],
            outfile: bundle,
            platform: "neutral",
          })
      );

      const world = yield* prepare(1000, [], undefined, {
        bundle,
        mayMail: ["desk/test"],
      });

      yield* start(world);
      const authorization = yield* bearer(world.driver, "submitPlan");

      const child = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const process = spawn(
            "node",
            ["--input-type=module", "-e", clientScript],
            { stdio: ["pipe", "pipe", "pipe"] }
          );

          process.stdin.end(
            JSON.stringify({
              body: JSON.stringify({ plan, runId: "run" }),
              headers: { authorization, "content-type": "application/json" },
              url: `http://127.0.0.1:${world.port}/submitPlan`,
            })
          );

          return process;
        }),
        kill
      );

      const output: string[] = [];
      child.stdout.on("data", (data: Buffer) => {
        output.push(data.toString());
      });

      yield* postStored(world, "readRun", { runId: "run" }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          while: ({ body, status }) =>
            status !== 200 ||
            !decodeJournal(body).journal.some(
              ({ entry, key }) =>
                key.startsWith("think-attempt:") && pendingAttempt(entry)
            ),
        }),
        Effect.timeout("10 seconds")
      );

      const stored = yield* Effect.sync(() => output.join("")).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 millis"),
          while: (text) => !text.endsWith("\n"),
        }),
        Effect.timeout("1 second")
      );

      expect(decodeStored(stored).status).toBe("running");
      yield* kill(child);

      const mid = decodeReport(
        (yield* postStored(world, "inspectRun", { runId: "run" })).body
      );

      expect(mid.status).toBe("running");

      const finished = yield* postStored(world, "inspectRun", {
        runId: "run",
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          while: ({ body }) => decodeReport(body).status === "running",
        }),
        Effect.timeout("10 seconds")
      );

      expect(decodeReport(finished.body)).toEqual({
        docs: { work: "work finished" },
        status: "done",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
    ),
  30_000
);

const hang = async <A>(): Promise<A> => {
  await setTimeout(2 ** 31 - 1, undefined, { ref: false });

  return await hang<A>();
};

const cutPromise = async <A>(
  cut: Cut,
  label: string,
  work: () => Promise<A>
): Promise<A> => (reaches(cut, label) ? await hang<A>() : await work());

const alarmPort = (clock: AlarmClock, cut: Cut) => ({
  clear: async () => {
    if (!reaches(cut, "alarms.clear")) {
      clock.pending = await Promise.resolve(null);
    }
  },
  get: async () => {
    reaches(cut, "alarms.get");

    return await Promise.resolve(clock.pending);
  },
  set: async (at: number) => {
    if (!reaches(cut, "alarms.set")) {
      clock.pending = await Promise.resolve(at);
    }
  },
});

const GUARD_MS = 150;

const Kind = Schema.Literals(["think", "ask"]);

type StepKind = typeof Kind.Type;

const planOf = (kinds: readonly StepKind[]) => ({
  defaults: { agent: { model: "sol", thinking: "low" } },
  envelope: {
    maxAgents: kinds.length,
    maxDepth: 3,
    maxSteps: 40,
    maxThinking: "low",
    models: ["sol"],
    names: ["desk/test"],
    thresholds: { judge: 0.8 },
  },
  goal: "Finish the same work whichever await an alarm turn is cut at",
  id: "cut-proof",
  machine: {
    id: "cut-proof",
    initial: "s0",
    states: {
      ...Object.fromEntries(
        kinds.map((kind, index) => [
          `s${index}`,
          {
            meta: {
              step:
                kind === "think"
                  ? { kind, prompt: `s${index}`, writes: `s${index}` }
                  : {
                      kind,
                      message: `s${index}`,
                      to: "desk/test",
                      writes: `s${index}`,
                    },
            },
            on: {
              [kind === "think" ? "done" : "replied"]: {
                target: index + 1 === kinds.length ? "end" : `s${index + 1}`,
              },
            },
          },
        ])
      ),
      end: { type: "final" },
    },
  },
});

interface Calls {
  readonly thinks: string[];
  readonly seals: string[];
  readonly sends: { readonly key: string; readonly envelope: string }[];
}

const servicesOn = (storage: SqlStorage, cut: Cut, calls: Calls) =>
  Layer.mergeAll(
    Layer.succeed(
      Thinker,
      Thinker.of({
        decide: () => Effect.die("unused"),
        elaborate: () => Effect.die("unused"),
        think: ({ key, prompt }) =>
          cutEffect(
            cut,
            `think ${key}`,
            Effect.sync(() => {
              calls.thinks.push(key);

              return { output: `${prompt} thought`, tokens: 1 };
            })
          ),
      })
    ),
    Layer.succeed(
      Judge,
      Judge.of({
        choose: () => Effect.die("unused"),
      })
    ),
    postboxMail(storage, () => ({
      seal: async (_object, _to, body) =>
        await cutPromise(cut, `seal ${body}`, async () => {
          calls.seals.push(body);

          return await Promise.resolve({
            envelope: `sealed:${body}:${calls.seals.length}`,
            messageId: `message-${calls.seals.length}`,
            ok: true as const,
          });
        }),
      send: async (envelope) =>
        await cutPromise(cut, `send ${envelope}`, async () => {
          calls.sends.push({
            envelope,
            key: envelope.split(":")[1] ?? "",
          });

          return await Promise.resolve({ ok: true as const });
        }),
    })),
    Layer.succeed(Operator, Operator.of({ notify: () => Effect.void })),
    Layer.succeed(EnabledStepKinds, new Set()),
    Layer.succeed(CallRegistry, new Map())
  );

const hostOn = (
  storage: SqlStorage,
  clock: AlarmClock,
  cut: Cut,
  calls: Calls
) => {
  const frozen = frozenAfterCut(storage, cut);

  return makePlanRun({
    alarms: alarmPort(clock, cut),
    guardMs: GUARD_MS,
    services: servicesOn(frozen, cut, calls),
    storage: frozen,
  });
};

const decodeRunReport = Schema.decodeUnknownSync(RunReportSchema);

const call = (host: PlanRun, capability: string, body: Schema.Json) =>
  Effect.promise(async () => {
    const response = await host.fetch(
      new Request(`http://plan-run/${capability}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );

    return { body: await response.json(), status: response.status };
  });

const inspect = (host: PlanRun) =>
  call(host, "inspectRun", { runId: "run" }).pipe(
    Effect.map(({ body }) => decodeRunReport(body))
  );

const fire = (host: PlanRun, clock: AlarmClock) =>
  Effect.gen(function* fireAlarm() {
    clock.pending = null;

    const controller = new AbortController();

    const turn = yield* Effect.promise(async () => {
      await host.alarm(controller.signal);
    }).pipe(Effect.ignoreCause, Effect.forkScoped);

    return { controller, turn };
  });

const settle = (host: PlanRun, clock: AlarmClock) =>
  Effect.gen(function* settleByAlarms() {
    for (let turn = 0; turn < 60; turn += 1) {
      const report = yield* inspect(host);

      if (report.status === "waiting-for-reply") {
        for (const awaiting of report.awaiting ?? []) {
          yield* call(host, "deliverReply", {
            body: `reply:${awaiting.key}`,
            from: awaiting.to,
            replyTo: awaiting.messageId,
          });
        }

        continue;
      }

      if (report.status !== "running") {
        return report;
      }

      const { pending } = clock;

      if (pending === null) {
        return yield* Effect.die(
          "the run is running with no alarm armed, so nothing will ever drive it again"
        );
      }

      yield* Effect.sleep(
        Math.max(0, pending - (yield* Clock.currentTimeMillis))
      );

      const { turn: driving } = yield* fire(host, clock);

      yield* Fiber.join(driving);
    }

    return yield* Effect.die("the run did not settle in 60 alarms");
  });

const fileFor = Effect.gen(function* sqliteFile() {
  const fs = yield* FileSystem.FileSystem;

  return (yield* Path.Path).join(
    yield* fs.makeTempDirectoryScoped(),
    "run.sqlite"
  );
});

const JournalKey = Schema.Struct({ key: Schema.String });

const committedAt = (storage: SqlStorage) =>
  storage.sql
    .exec("SELECT key FROM mischief_journal WHERE run_id = 'run' ORDER BY key")
    .toArray()
    .map((row) => Schema.decodeUnknownSync(JournalKey)(row).key);

const end = ({ docs, failures, status, transitions }: RunReport) => ({
  docs,
  failures,
  status,
  transitions,
});

const playOut = (kinds: readonly StepKind[], cut: number | null) =>
  Effect.gen(function* playRun() {
    const file = yield* fileFor;
    const storage = nodeSqlStorage(file);
    const calls: Calls = { seals: [], sends: [], thinks: [] };
    const clock: AlarmClock = { pending: null };

    rememberObject(storage, "owner/run");

    const submitter = hostOn(storage, clock, neverCut(), calls);

    yield* call(submitter, "submitPlan", { plan: planOf(kinds), runId: "run" });

    const before = clock.pending;
    const cutting = cut === null ? neverCut() : cutAt(cut);
    const host = hostOn(nodeSqlStorage(file), clock, cutting, calls);

    cutting.landed = 0;

    const { controller, turn } = yield* fire(host, clock);

    yield* Effect.raceFirst(
      Fiber.join(turn),
      Effect.sleep(5).pipe(
        Effect.repeat({ while: () => cutting.tripped === null })
      )
    );

    const after = {
      committed: committedAt(storage),
      landed: cutting.landed,
      pending: clock.pending,
      tripped: cutting.tripped,
    };

    controller.abort();
    yield* Fiber.join(turn);

    if (after.tripped !== null && after.landed === 0) {
      clock.pending ??= before;
    }

    const report = yield* settle(
      hostOn(nodeSqlStorage(file), clock, neverCut(), calls),
      clock
    );

    return { after, before, calls, report };
  });

it.live.prop(
  "a PlanRun alarm turn cut at any await after its first write leaves an alarm armed (a turn cut before any write is redelivered by the platform), the next alarms finish the run as an uncut turn would, and no committed step runs again",
  {
    cut: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 14, minimum: 1 }))
    ),
    kinds: Arbitrary.schema(
      Schema.Array(Kind).check(Schema.isMinLength(1), Schema.isMaxLength(4))
    ),
  },
  ({ cut, kinds }) =>
    Effect.gen(function* cutTurn() {
      const model = yield* playOut(kinds, null);
      const run = yield* playOut(kinds, cut);

      expect(model.report.status).toBe("done");
      expect(run.before).not.toBeNull();

      if (run.after.tripped !== null && run.after.landed > 0) {
        expect(
          run.after.pending,
          `cut at ${run.after.tripped} after ${run.after.landed} writes landed`
        ).not.toBeNull();
      }

      expect(end(run.report)).toStrictEqual(end(model.report));

      const finished = new Set(
        run.after.committed.flatMap((key) => {
          const step = /^(?:logic:.*\.|seal:)(?<step>s\d+)#/u.exec(key)?.groups
            ?.step;

          return step === undefined ? [] : [step];
        })
      );

      for (const step of finished) {
        expect(
          run.calls.thinks.filter((key) => key === step).length,
          `think ${step} committed before the cut`
        ).toBeLessThanOrEqual(1);
        expect(
          run.calls.seals.filter((body) => body === step).length,
          `seal ${step} committed before the cut`
        ).toBeLessThanOrEqual(1);
      }

      const delivered = new Map<string, Set<string>>();

      for (const { envelope, key } of run.calls.sends) {
        delivered.set(key, (delivered.get(key) ?? new Set()).add(envelope));
      }

      for (const [key, envelopes] of delivered) {
        expect(
          envelopes.size,
          `every send for ${key} carries one envelope`
        ).toBe(1);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 40 }, timeout: 120_000 }
);

const SCHEDULE = "climb";

const zeroStep = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 20,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Nothing to do",
  id: "no-op",
  machine: { id: "no-op", initial: "end", states: { end: { type: "final" } } },
};

const reportOf = (runId: string): RunReport => ({
  docs: {},
  planId: "no-op",
  planVersion: 1,
  runId,
  status: "done",
  transitions: 0,
  value: null,
});

const objectOn = (
  storage: SqlStorage,
  clock: AlarmClock,
  cut: Cut,
  submitted: string[]
): ScheduleObject => {
  const frozen = frozenAfterCut(storage, cut);

  return makeSchedule({
    alarms: alarmPort(clock, cut),
    guardMs: GUARD_MS,
    notices: ScheduleNotices.of({
      ended: ({ key }) => cutEffect(cut, `notice ${key}`, Effect.void),
    }),
    runs: WakeRuns.of({
      abort: (runId) => cutEffect(cut, `abort ${runId}`, Effect.void),
      inspect: (runId) =>
        cutEffect(
          cut,
          `inspect ${runId}`,
          Effect.sync(() =>
            submitted.includes(runId)
              ? Option.some(reportOf(runId))
              : Option.none()
          )
        ),
      submit: (runId) =>
        cutEffect(
          cut,
          `submit ${runId}`,
          Effect.sync(() => {
            submitted.push(runId);
          })
        ),
    }),
    storage: frozen,
  });
};

const callSchedule = (
  object: ScheduleObject,
  capability: string,
  body: Schema.Json
) =>
  Effect.promise(async () => {
    const response = await object.fetch(
      new Request(`http://schedule/${capability}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );

    return { body: await response.json(), status: response.status };
  });

const fireSchedule = (object: ScheduleObject, clock: AlarmClock) =>
  Effect.sync(() => {
    clock.pending = null;
  }).pipe(
    Effect.andThen(
      Effect.promise(async () => {
        await object.alarm();
      }).pipe(Effect.ignoreCause, Effect.forkScoped)
    )
  );

const settleSchedule = (object: ScheduleObject, clock: AlarmClock) =>
  Effect.gen(function* settleByAlarms() {
    for (let turn = 0; turn < 10; turn += 1) {
      const { pending } = clock;
      const now = yield* Clock.currentTimeMillis;

      if (pending === null) {
        return yield* Effect.die(
          "the schedule has no alarm armed, so its next wake never comes"
        );
      }

      if (pending - now > 10_000) {
        return pending;
      }

      yield* Effect.sleep(Math.max(0, pending - now));
      yield* Fiber.join(yield* fireSchedule(object, clock));
    }

    return yield* Effect.die("the schedule kept waking in 10 alarms");
  });

const decodeSchedule = Schema.decodeUnknownSync(ScheduleReportSchema);

const playSchedule = (cut: number | null) =>
  Effect.gen(function* playScheduleTurns() {
    const file = yield* fileFor;
    const clock: AlarmClock = { pending: null };
    const submitted: string[] = [];

    yield* callSchedule(
      objectOn(nodeSqlStorage(file), clock, neverCut(), submitted),
      "createSchedule",
      { every: "1 minute", maxWakes: 3, plan: zeroStep, scheduleId: SCHEDULE }
    );

    const before = clock.pending;
    const cutting = cut === null ? neverCut() : cutAt(cut);
    const object = objectOn(nodeSqlStorage(file), clock, cutting, submitted);

    cutting.landed = 0;

    const turn = yield* fireSchedule(object, clock);

    yield* Effect.raceFirst(
      Fiber.join(turn),
      Effect.sleep(5).pipe(
        Effect.repeat({ while: () => cutting.tripped === null })
      )
    );

    const after = {
      landed: cutting.landed,
      pending: clock.pending,
      tripped: cutting.tripped,
    };

    yield* Fiber.interrupt(turn);

    if (after.tripped !== null && after.landed === 0) {
      clock.pending ??= before;
    }

    const fresh = objectOn(nodeSqlStorage(file), clock, neverCut(), submitted);
    const armed = yield* settleSchedule(fresh, clock);

    const report = decodeSchedule(
      (yield* callSchedule(fresh, "inspectSchedule", { scheduleId: SCHEDULE }))
        .body
    );

    return { after, armed, report, submitted };
  });

it.live.prop(
  "a Schedule alarm turn cut at any await after its first write leaves an alarm armed (a turn cut before any write is redelivered by the platform), and the next alarms start the due wake exactly as an uncut turn would",
  {
    cut: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 1 }))
    ),
  },
  ({ cut }) =>
    Effect.gen(function* cutScheduleTurn() {
      const model = yield* playSchedule(null);
      const run = yield* playSchedule(cut);

      expect(model.submitted).toStrictEqual([`${SCHEDULE}-wake-1`]);

      if (run.after.tripped !== null && run.after.landed > 0) {
        expect(
          run.after.pending,
          `cut at ${run.after.tripped} after ${run.after.landed} writes landed`
        ).not.toBeNull();
      }

      expect(new Set(run.submitted)).toStrictEqual(new Set(model.submitted));
      expect(run.report.wakeCount).toBe(model.report.wakeCount);
      expect(run.report.ended).toBe(null);
      expect(run.armed).toBe(run.report.nextAt);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 30 }, timeout: 60_000 }
);
