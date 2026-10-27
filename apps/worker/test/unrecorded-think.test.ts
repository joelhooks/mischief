import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  bufferedRunStore,
  CallRegistry,
  callable,
  EnabledStepKinds,
  Judge,
  Mail,
  Operator,
  Drive,
  RedriveAttempts,
  RunHost,
  RunStore,
  StepFailed,
  Thinker,
} from "@mischief/core";
import type { Held, RunBackend, RunReport, StepCall } from "@mischief/core";
import { runBackendSql, webCrypto } from "@mischief/plan-run";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { fauxThinkerOptions, piThinker } from "@mischief/thinking";
import type { FauxReply } from "@mischief/thinking";
import { nodeSqliteStorageFor } from "@mischief/thinking/node";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { escalationText, heldText, holdAlarmText } from "../src/escalation.js";

const RUN = "unrecorded";

const WINDOW = 24;

const ALPHABET = [
  ...Array.from({ length: 26 }, (_, at) => String.fromCodePoint(97 + at)),
  ...Array.from({ length: 10 }, (_, at) => String(at)),
];

const SecretSchema = Schema.Array(Schema.Literals(ALPHABET)).check(
  Schema.isMinLength(32),
  Schema.isMaxLength(40)
);

const OutageSchema = Schema.Literals([429, 500, 503]);

const FaultSchema = Schema.Struct({
  at: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
  stage: Schema.Literals(["fetch", "model", "post"]),
});

type Fault = typeof FaultSchema.Type;

const StepSpecSchema = Schema.Struct({
  outages: Schema.Array(OutageSchema).check(Schema.isMaxLength(2)),
  promptReads: Schema.Boolean,
  secret: SecretSchema,
  source: Schema.Literals(["input", "reads"]),
});

type StepSpec = typeof StepSpecSchema.Type;

const InterruptionSchema = Schema.Struct({
  at: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 1 })),
  kind: Schema.Literals(["crashInStep", "crashAfterStep", "crashBeforeCommit"]),
});

type Interruption = typeof InterruptionSchema.Type;

const WorldArbitrary = Arbitrary.all({
  fault: Arbitrary.schema(Schema.NullOr(FaultSchema)),
  interruptions: Arbitrary.array(Arbitrary.schema(InterruptionSchema), {
    maxLength: 4,
  }),
  steps: Arbitrary.array(Arbitrary.schema(StepSpecSchema), {
    maxLength: 4,
    minLength: 1,
  }),
});

const stepName = (index: number) => `c${index}`;

const docName = (index: number) => `d${index}`;

const secretOf = (spec: StepSpec) => spec.secret.join("");

const heardOf = (secret: string) => `heard ${secret}`;

const postedOf = (index: number, secret: string) => ({
  chars: heardOf(secret).length,
  step: stepName(index),
});

const promptOf = (index: number, spec: StepSpec) =>
  spec.promptReads && index > 0
    ? `s${index}: summarise {{docs.${docName(index - 1)}}}`
    : `s${index}: summarise`;

const planOf = (steps: readonly StepSpec[]) => ({
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: 10,
    maxDepth: 3,
    maxSteps: 200,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  id: "unrecorded",
  machine: {
    id: "unrecorded",
    initial: stepName(0),
    states: Object.fromEntries<Schema.Json>([
      ["end", { type: "final" }],
      ...steps.map(
        (spec, index) =>
          [
            stepName(index),
            {
              meta: {
                step: {
                  ephemeral:
                    spec.source === "reads" && index > 0
                      ? { capability: "fetch", reads: [docName(index - 1)] }
                      : { capability: "fetch", input: { n: index } },
                  kind: "think",
                  post: { capability: "shrink" },
                  prompt: promptOf(index, spec),
                  writes: docName(index),
                },
              },
              on: {
                done: {
                  target:
                    index + 1 < steps.length ? stepName(index + 1) : "end",
                },
              },
            },
          ] as const
      ),
    ]),
  },
});

const faultAt = (fault: Option.Option<Fault>, index: number) =>
  fault.pipe(
    Option.filter(({ at }) => at === index),
    Option.map(({ stage }) => stage),
    Option.getOrUndefined
  );

const modelOf = (steps: readonly StepSpec[], fault: Option.Option<Fault>) => {
  const docs: Record<string, Schema.Json> = {};

  for (const [index, spec] of steps.entries()) {
    if (faultAt(fault, index) !== undefined) {
      docs[`failed:${stepName(index)}`] = true;

      return { docs, reached: index + 1, status: "failed" };
    }

    docs[docName(index)] = postedOf(index, secretOf(spec));
  }

  return { docs, reached: steps.length, status: "done" };
};

const windowsOf = (text: string) =>
  Array.from({ length: Math.max(0, text.length - WINDOW + 1) }, (_, at) =>
    text.slice(at, at + WINDOW)
  );

const STEP = /^s(?<index>\d+):/u;

interface World {
  readonly fault: Option.Option<Fault>;
  readonly steps: readonly StepSpec[];
  readonly outages: number[][];
  readonly calls: {
    readonly answered: Map<string, number>;
    readonly fetched: Map<string, number>;
    readonly modeled: Map<string, number>;
    readonly posted: Map<string, number>;
  };
  readonly emitted: string[];
}

const bump = (counts: Map<string, number>, key: string) => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

const respondFor =
  (world: World, alive: () => boolean) =>
  (prompt: string): FauxReply => {
    if (!alive()) {
      return { kind: "hang" };
    }

    const index = Number(STEP.exec(prompt)?.groups?.index ?? "-1");
    const spec = world.steps[index];
    const key = stepName(index);

    bump(world.calls.modeled, key);

    const outage = world.outages[index]?.shift();
    const quoted = JSON.stringify({ error: "overloaded", request: prompt });

    if (outage !== undefined) {
      return { kind: "error", message: `${outage} ${quoted}` };
    }

    if (spec !== undefined && faultAt(world.fault, index) === "model") {
      return { kind: "error", message: `400 ${quoted}` };
    }

    bump(world.calls.answered, key);

    return { kind: "answer", text: heardOf(prompt.split("\n\n")[1] ?? "") };
  };

const identityChecked = (call: StepCall) => {
  expect(call).toMatchObject({ epoch: 0, runId: RUN, visit: 1 });

  return call.key;
};

const registryFor = (world: World, alive: () => boolean) =>
  new Map([
    [
      "fetch",
      callable({
        input: Schema.Json,
        output: Schema.String,
        run: (input, call) =>
          Effect.suspend(() => {
            if (!alive()) {
              return Effect.never;
            }

            const key = identityChecked(call);
            const index = Number(key.slice(1));
            const spec = world.steps[index];
            const secret = spec === undefined ? "" : secretOf(spec);

            bump(world.calls.fetched, key);
            expect(input).toStrictEqual(
              spec?.source === "reads" && index > 0
                ? {
                    [docName(index - 1)]: postedOf(
                      index - 1,
                      secretOf(world.steps[index - 1] ?? spec)
                    ),
                  }
                : { n: index }
            );

            return faultAt(world.fault, index) === "fetch"
              ? Effect.fail(
                  new StepFailed({
                    key,
                    reason: `the source sent ${secret}, which is not a document`,
                  })
                )
              : Effect.succeed(secret);
          }),
      }),
    ],
    [
      "shrink",
      callable({
        input: Schema.Struct({
          answer: Schema.String,
          ephemeral: Schema.String,
        }),
        output: Schema.Struct({ chars: Schema.Int, step: Schema.String }),
        run: ({ answer, ephemeral }, call) =>
          Effect.suspend(() => {
            if (!alive()) {
              return Effect.never;
            }

            const key = identityChecked(call);
            const index = Number(key.slice(1));
            const spec = world.steps[index];

            bump(world.calls.posted, key);
            expect(ephemeral).toBe(spec === undefined ? "" : secretOf(spec));
            expect(answer).toBe(heardOf(ephemeral));

            return faultAt(world.fault, index) === "post"
              ? Effect.fail(
                  new StepFailed({
                    key,
                    reason: `could not shrink ${answer}`,
                  })
                )
              : Effect.succeed(postedOf(index, ephemeral));
          }),
      }),
    ],
  ]);

const operatorFor = (world: World) =>
  Operator.of({
    held: (runId: string, held: Held) =>
      Effect.sync(() => {
        world.emitted.push(
          JSON.stringify(held),
          heldText(runId, held),
          holdAlarmText(runId, [held], 1)
        );
      }),
    holdAlarm: (runId, held, attempts) =>
      Effect.sync(() => {
        world.emitted.push(holdAlarmText(runId, held, attempts));
      }),
    notify: (runId, question) =>
      Effect.sync(() => {
        world.emitted.push(escalationText(runId, question));
      }),
    thought: (_, key, receipt) =>
      Effect.sync(() => {
        world.emitted.push(JSON.stringify({ key, receipt }));
      }),
  });

const logged = (world: World) =>
  Logger.layer([
    Logger.formatJson.pipe(Logger.map((line) => world.emitted.push(line))),
  ]);

const recording = (backend: RunBackend, world: World): RunBackend => ({
  ...backend,
  apply: (runId, changes) =>
    Effect.suspend(() => {
      world.emitted.push(
        JSON.stringify({
          docs: [...changes.docs],
          fingerprints: [...changes.fingerprints],
          journal: [...changes.journal],
          messages: [...changes.messages],
          plans: [...changes.plans],
          run: changes.run ?? null,
        })
      );

      return backend.apply(runId, changes);
    }),
});

const incarnation = (
  backend: RunBackend,
  world: World,
  dir: string,
  plan: Schema.Json,
  interruption?: Interruption
) =>
  Effect.gen(function* oneProcess() {
    const victim = yield* Deferred.make<Fiber.Fiber<RunReport, unknown>>();
    const counters = { dead: false, saves: 0, steps: 0 };
    const alive = () => !counters.dead;
    const base = bufferedRunStore(backend);

    const die = Effect.gen(function* stopProcess() {
      counters.dead = true;
      const fiber = yield* Deferred.await(victim);
      yield* Effect.forkDetach(Fiber.interrupt(fiber));

      return yield* Effect.never;
    });

    const store = RunStore.of({
      ...base,
      commit: (runId) => (counters.dead ? Effect.never : base.commit(runId)),
      writeDoc: (runId, name, value) =>
        counters.dead ? Effect.never : base.writeDoc(runId, name, value),
      writeJournal: (runId, key, entry) =>
        Effect.suspend(() => {
          if (counters.dead) {
            return Effect.never;
          }

          if (key.startsWith("logic:")) {
            counters.steps += 1;
          }

          const here =
            key.startsWith("logic:") && counters.steps === interruption?.at;

          if (here && interruption.kind === "crashInStep") {
            return die;
          }

          const written = base.writeJournal(runId, key, entry);

          return here && interruption.kind === "crashAfterStep"
            ? written.pipe(Effect.andThen(die))
            : written;
        }),
      writeRun: (runId, state) =>
        Effect.suspend(() => {
          if (counters.dead) {
            return Effect.never;
          }

          counters.saves += 1;
          const written = base.writeRun(runId, state);

          return counters.saves === interruption?.at &&
            interruption.kind === "crashBeforeCommit"
            ? written.pipe(Effect.andThen(die))
            : written;
        }),
    });

    const thinker = yield* Layer.build(
      piThinker(
        fauxThinkerOptions(nodeSqliteStorageFor(dir), respondFor(world, alive))
      )
    );

    const host = yield* RunHost.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Drive.inline,
          webCrypto,
          Judge.unwired,
          Mail.unwired,
          Layer.succeed(Operator, operatorFor(world))
        )
      ),
      Effect.provide(thinker),
      Effect.provideService(RedriveAttempts, Number.MAX_SAFE_INTEGER),
      Effect.provideService(RunStore, store),
      Effect.provideService(CallRegistry, registryFor(world, alive)),
      Effect.provideService(EnabledStepKinds, new Set(["call"] as const))
    );

    const work = Effect.gen(function* drive() {
      const stored = yield* backend.readRun(RUN);

      if (Option.isNone(stored)) {
        return yield* host.submit(RUN, plan);
      }

      return stored.value.status === "waiting-for-provider"
        ? yield* host.resume(RUN)
        : yield* host.advance(RUN);
    }).pipe(Effect.provide(logged(world)));

    const fiber = yield* Effect.forkChild(work);
    yield* Deferred.succeed(victim, fiber);
    const exit = yield* Effect.exit(Fiber.join(fiber));

    world.emitted.push(
      Exit.match(exit, {
        onFailure: (cause) => Cause.pretty(cause),
        onSuccess: (report) => JSON.stringify(report),
      })
    );

    return { exit, host };
  }).pipe(Effect.scoped);

const persistedText = (dir: string) =>
  Effect.gen(function* readPersisted() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const decoder = new TextDecoder("latin1");

    return yield* fs
      .readDirectory(dir)
      .pipe(
        Effect.flatMap(
          Effect.forEach((name) =>
            fs
              .readFile(path.join(dir, name))
              .pipe(
                Effect.map((bytes) => ({ name, text: decoder.decode(bytes) }))
              )
          )
        )
      );
  });

const leaksIn = (
  haystacks: readonly { readonly name: string; readonly text: string }[],
  secrets: readonly string[]
) =>
  secrets.flatMap((secret) =>
    [...windowsOf(secret), ...windowsOf(heardOf(secret))].flatMap((window) =>
      haystacks.flatMap(({ name, text }) =>
        text.includes(window) ? [`${name} holds "${window}"`] : []
      )
    )
  );

const settled = (report: RunReport) =>
  report.status === "done" || report.status === "failed";

const committedStep = (
  journal: ReadonlyMap<string, Schema.Json>,
  key: string
) =>
  [...journal.keys()].some(
    (entry) => entry.startsWith("logic:") && entry.endsWith(`.${key}#1`)
  );

const driven = (
  backend: RunBackend,
  world: World,
  dir: string,
  plan: Schema.Json,
  interruptions: readonly Interruption[]
) =>
  Effect.gen(function* driveUntilSettled() {
    const caught = new Map<string, number>();
    const pending = [...interruptions];
    const budget = pending.length + world.steps.length * 3 + 2;

    for (let round = 0; round < budget; round += 1) {
      const before = new Map(world.calls.answered);

      const { exit } = yield* incarnation(
        backend,
        world,
        dir,
        plan,
        pending.shift()
      );

      if (Exit.isSuccess(exit) && settled(exit.value)) {
        return { caught, report: exit.value };
      }

      if (Exit.isFailure(exit)) {
        const committed = yield* backend.readJournal(RUN);

        for (const [key, times] of world.calls.answered) {
          if (
            times > (before.get(key) ?? 0) &&
            !committedStep(committed, key)
          ) {
            bump(caught, key);
          }
        }
      }
    }

    return yield* Effect.die(`the run did not settle in ${budget} rounds`);
  });

const count = (counts: ReadonlyMap<string, number>, key: string) =>
  counts.get(key) ?? 0;

const expectCalls = (
  world: World,
  reached: number,
  caught: ReadonlyMap<string, number>
) => {
  const { answered, fetched, posted } = world.calls;

  for (const index of world.steps.keys()) {
    const key = stepName(index);
    const stage = faultAt(world.fault, index);

    if (index >= reached) {
      expect(count(fetched, key)).toBe(0);
    } else if (stage === "fetch" || stage === "model") {
      expect(count(fetched, key)).toBeGreaterThanOrEqual(1);
      expect(count(answered, key)).toBe(0);
      expect(count(posted, key)).toBe(0);
    } else {
      expect(count(fetched, key)).toBeGreaterThanOrEqual(1);
      expect(count(answered, key)).toBeGreaterThanOrEqual(1);
      expect(count(answered, key)).toBeLessThanOrEqual(1 + count(caught, key));
      expect(count(posted, key)).toBeGreaterThanOrEqual(1);
      expect(count(posted, key)).toBeLessThanOrEqual(count(answered, key));
    }
  }
};

const restartFromLog = (backend: RunBackend) =>
  Effect.gen(function* restart() {
    const state = Option.getOrThrow(yield* backend.readRun(RUN));
    const store = bufferedRunStore(backend);

    yield* store.open(RUN);
    yield* store.writeRun(RUN, {
      ...state,
      checkpoint: null,
      status: "running",
      transitions: 0,
      value: null,
    });
    yield* store.commit(RUN);
    yield* store.close(RUN);
  });

const callsMade = (world: World) =>
  [...world.calls.modeled.values(), ...world.calls.fetched.values()].reduce(
    (sum, times) => sum + times,
    0
  );

it.effect.prop(
  "an ephemeral think gives the model its input and records only post's output: docs match the model under crashes and outages, each step reruns only when a crash caught it, replay calls nothing, and nothing persisted or emitted holds the input or the raw answer",
  { world: WorldArbitrary },
  ({ world: generated }) =>
    Effect.gen(function* property() {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const { steps } = generated;
      const plan = planOf(steps);
      const fault = Option.fromNullOr(generated.fault);
      const expected = modelOf(steps, fault);

      const world: World = {
        calls: {
          answered: new Map(),
          fetched: new Map(),
          modeled: new Map(),
          posted: new Map(),
        },
        emitted: [],
        fault,
        outages: steps.map(({ outages }) => [...outages]),
        steps,
      };

      const runStorage = nodeSqlStorage(`${dir}/run.sqlite`);
      runStorage.sql.exec("PRAGMA synchronous = OFF");

      const backend = recording(yield* runBackendSql(runStorage), world);

      const { caught, report } = yield* driven(
        backend,
        world,
        dir,
        plan,
        generated.interruptions
      );

      expect(report.status).toBe(expected.status);
      expect(report.docs).toStrictEqual(expected.docs);
      expectCalls(world, expected.reached, caught);

      const made = callsMade(world);
      const again = yield* incarnation(backend, world, dir, plan);

      expect(Exit.isSuccess(again.exit) && again.exit.value).toStrictEqual(
        report
      );

      yield* restartFromLog(backend);

      const replayed = yield* incarnation(backend, world, dir, plan);

      expect(callsMade(world)).toBe(made);
      expect(
        Exit.isSuccess(replayed.exit) && {
          docs: replayed.exit.value.docs,
          status: replayed.exit.value.status,
        }
      ).toStrictEqual({ docs: report.docs, status: report.status });

      if ([...world.calls.answered.values()].some((times) => times > 0)) {
        expect(
          world.emitted.some((line) => line.includes("mischief.think")),
          "the test captures the Thinker's logs"
        ).toBe(true);
      }

      const persisted = yield* persistedText(dir);

      expect(
        persisted.some(({ text }) => text.includes(`"${stepName(0)}"`)),
        "the scan reads the run's tables"
      ).toBe(true);

      expect(
        leaksIn(
          [
            ...persisted,
            ...world.emitted.map((text, index) => ({
              name: `emitted #${index}`,
              text,
            })),
          ],
          steps.map(secretOf)
        )
      ).toStrictEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 100 }, timeout: 300_000 }
);

it.effect(
  "the canary scan reads the thinking store: a recorded think leaves its prompt there",
  () =>
    Effect.gen(function* recordedLands() {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const marker = "recorded0prompt0lands0in0the0thinking0store";

      const thinker = yield* Layer.build(
        piThinker(fauxThinkerOptions(nodeSqliteStorageFor(dir)))
      );

      yield* Thinker.use((thinking) =>
        thinking.think({
          agent: { model: "sol" },
          ceiling: "low",
          epoch: 0,
          key: "draft",
          prompt: marker,
          runId: RUN,
          visit: 1,
        })
      ).pipe(Effect.provide(thinker));

      const persisted = yield* persistedText(dir);

      expect(leaksIn(persisted, [marker])).not.toStrictEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
