import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  EnabledStepKinds,
  STEP_KINDS_FLAG,
} from "../../src/plans/step-kinds.js";
import { RunHost } from "../../src/runs/host.js";
import {
  bufferedRunStore,
  memoryRunBackend,
  RunStore,
} from "../../src/runs/run-store.js";
import type { RunBackend } from "../../src/runs/run-store.js";
import type { RunReport, RunState } from "../../src/runs/schema.js";
import { CallRegistry, callable } from "../../src/steps/call-registry.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";

const RUN = "call-run";

const ECHO_LIMIT = 12;

const Word = Schema.Literals(["a", "b", "c"]);

const echoOf = (invoked: string[]) =>
  callable({
    input: Schema.Record(Schema.String, Schema.String),
    output: Schema.String.check(Schema.isMaxLength(ECHO_LIMIT)),
    run: (input, { key, runId, visit }) =>
      Effect.sync(() => {
        invoked.push(`${runId}/${key}#${visit}`);

        return Object.values(input).join(" ");
      }),
  });

const registryOf = (invoked: string[]) => new Map([["echo", echoOf(invoked)]]);

const enabled = new Set(["call"] as const);

const envelope = {
  maxAgents: 0,
  maxDepth: 3,
  maxSteps: 200,
  maxThinking: "low",
  models: ["m"],
  names: [],
  thresholds: { judge: 0.8 },
} as const;

const services = Layer.mergeAll(
  NodeCrypto.layer,
  Judge.unwired,
  Mail.unwired,
  Thinker.unwired,
  Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
);

const oneCall = (capability: string, input: Schema.Json) => ({
  defaults: { agent: {} },
  envelope,
  id: "one-call",
  machine: {
    id: "one-call",
    initial: "fetch",
    states: {
      end: { type: "final" },
      fetch: {
        meta: { step: { capability, input, kind: "call", writes: "got" } },
        on: { done: { target: "end" } },
      },
    },
  },
});

const GateSchema = Schema.Struct({
  known: Schema.Boolean,
  on: Schema.Boolean,
});

it.effect.prop(
  "a call step is refused while the host leaves it off, refused for a capability the host never registered, and accepted otherwise",
  { gate: Arbitrary.schema(GateSchema) },
  ({ gate }) =>
    Effect.gen(function* gated() {
      const invoked: string[] = [];
      const capability = gate.known ? "echo" : "fetch-weather";

      const build = RunHost.make.pipe(
        Effect.provide(services),
        Effect.provideService(CallRegistry, registryOf(invoked))
      );

      const runs = yield* gate.on
        ? build.pipe(Effect.provideService(EnabledStepKinds, enabled))
        : build;

      const exit = yield* Effect.exit(
        runs.submit(RUN, oneCall(capability, { text: "a" }))
      );

      if (!gate.on) {
        expect(exit).toMatchObject({
          cause: {
            reasons: [
              {
                error: {
                  errors: [
                    expect.stringMatching(
                      new RegExp(
                        `fetch: step kind "call" is off on this host.*${STEP_KINDS_FLAG}=call.*needs Joel's approval`,
                        "u"
                      )
                    ),
                  ],
                },
              },
            ],
          },
        });
        expect(invoked).toStrictEqual([]);

        return;
      }

      if (!gate.known) {
        expect(exit).toMatchObject({
          cause: {
            reasons: [
              {
                error: {
                  errors: [
                    'fetch: call names capability "fetch-weather", which this host has not registered. Registered: echo. Use one of those names',
                  ],
                },
              },
            ],
          },
        });
        expect(invoked).toStrictEqual([]);

        return;
      }

      expect(Exit.isSuccess(exit) && exit.value.status).toBe("done");
      expect(invoked).toStrictEqual([`${RUN}/fetch#1`]);
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 30 } }
);

it.effect(
  "a call whose output breaks the capability's output schema fails the step and records nothing",
  () =>
    Effect.gen(function* refusedOutput() {
      const invoked: string[] = [];

      const runs = yield* RunHost.make.pipe(
        Effect.provide(services),
        Effect.provideService(CallRegistry, registryOf(invoked)),
        Effect.provideService(EnabledStepKinds, enabled)
      );

      const report = yield* runs.submit(
        RUN,
        oneCall("echo", { first: "a long line", second: "of words" })
      );

      expect(invoked).toStrictEqual([`${RUN}/fetch#1`]);
      expect(report.status).toBe("failed");
      expect(report.docs.got).toBeUndefined();
      expect(report.failures?.map(({ reason }) => reason)).toStrictEqual([
        expect.stringContaining("output its output schema refuses"),
      ]);
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory)))
);

const StepSpecSchema = Schema.Struct({
  from: Schema.Literals(["literal", "previous"]),
  stopOn: Schema.optionalKey(Word),
  text: Word,
});

type StepSpec = typeof StepSpecSchema.Type;

const InterruptionSchema = Schema.Struct({
  at: Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 1 })),
  kind: Schema.Literals(["crashInStep", "crashAfterStep", "crashBeforeCommit"]),
});

type Interruption = typeof InterruptionSchema.Type;

const WorldArbitrary = Arbitrary.all({
  interruptions: Arbitrary.array(Arbitrary.schema(InterruptionSchema), {
    maxLength: 4,
  }),
  steps: Arbitrary.array(Arbitrary.schema(StepSpecSchema), {
    maxLength: 5,
    minLength: 1,
  }),
});

const callName = (index: number) => `c${index}`;

const nextOf = (steps: readonly StepSpec[], index: number) =>
  index + 1 < steps.length ? callName(index + 1) : "end";

const planOf = (steps: readonly StepSpec[]) => ({
  defaults: { agent: {} },
  envelope,
  id: "calls",
  machine: {
    id: "calls",
    initial: callName(0),
    states: Object.fromEntries<Schema.Json>([
      ["end", { type: "final" }],
      ...steps.flatMap((spec, index) => {
        const source =
          spec.from === "previous" && index > 0
            ? { reads: [`d${index - 1}`] }
            : { input: { text: spec.text } };

        const call = [
          callName(index),
          {
            meta: {
              step: {
                capability: "echo",
                kind: "call",
                writes: `d${index}`,
                ...source,
              },
            },
            on: {
              done: {
                target:
                  spec.stopOn === undefined
                    ? nextOf(steps, index)
                    : `s${index}`,
              },
            },
          },
        ] as const;

        return spec.stopOn === undefined
          ? [call]
          : [
              call,
              [
                `s${index}`,
                {
                  meta: {
                    step: {
                      cases: { [spec.stopOn]: "stop" },
                      default: "go",
                      kind: "switch",
                      reads: `d${index}`,
                    },
                  },
                  on: {
                    go: { target: nextOf(steps, index) },
                    stop: { target: "end" },
                  },
                },
              ] as const,
            ];
      }),
    ]),
  },
});

const modelOf = (steps: readonly StepSpec[]) => {
  const docs: Record<string, string> = {};
  const reached: string[] = [];
  let previous = "";

  for (const [index, spec] of steps.entries()) {
    const text = spec.from === "previous" && index > 0 ? previous : spec.text;

    reached.push(`${RUN}/${callName(index)}#1`);
    docs[`d${index}`] = text;
    previous = text;

    if (spec.stopOn === text) {
      break;
    }
  }

  return { docs, reached };
};

const incarnation = (
  backend: RunBackend,
  invoked: string[],
  plan: Schema.Json,
  first: boolean,
  interruption?: Interruption
) =>
  Effect.gen(function* oneProcess() {
    const victim = yield* Deferred.make<Fiber.Fiber<RunReport, unknown>>();
    const counters = { dead: false, saves: 0, steps: 0 };
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

    const host = yield* RunHost.make.pipe(
      Effect.provide(services),
      Effect.provideService(RunStore, store),
      Effect.provideService(CallRegistry, registryOf(invoked)),
      Effect.provideService(EnabledStepKinds, enabled)
    );

    const work = Effect.gen(function* drive() {
      const submitted = Option.isSome(yield* backend.readRun(RUN));

      return first || !submitted
        ? yield* host.submit(RUN, plan)
        : yield* host.advance(RUN);
    });

    const fiber = yield* Effect.forkChild(work);
    yield* Deferred.succeed(victim, fiber);
    const exit = yield* Effect.exit(Fiber.join(fiber));

    return { exit, host, store };
  });

const counted = (invoked: readonly string[]) => {
  const counts = new Map<string, number>();

  for (const key of invoked) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
};

const restartFromLog = (
  store: ReturnType<typeof bufferedRunStore>,
  state: RunState
) =>
  Effect.gen(function* restart() {
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

it.effect.prop(
  "a run of call steps calls each reached step once, plus at most once more per crash that caught it running; replaying its log and re-driving it call nothing",
  { world: WorldArbitrary },
  ({ world }) =>
    Effect.gen(function* property() {
      const plan = planOf(world.steps);
      const expected = modelOf(world.steps);
      const backend = memoryRunBackend();
      const invoked: string[] = [];
      let first = true;
      let crashes = 0;

      for (const interruption of world.interruptions) {
        const { exit } = yield* incarnation(
          backend,
          invoked,
          plan,
          first,
          interruption
        );

        first = false;

        if (Exit.isFailure(exit)) {
          crashes += 1;
        }
      }

      const final = yield* incarnation(backend, invoked, plan, first);
      const report = yield* final.exit;

      expect(report.status).toBe("done");
      expect(report.value).toBe("end");
      expect(report.docs).toStrictEqual(expected.docs);

      const counts = counted(invoked);

      expect([...counts.keys()].toSorted()).toStrictEqual(
        expected.reached.toSorted()
      );

      for (const times of counts.values()) {
        expect(times).toBeLessThanOrEqual(1 + crashes);
      }

      const before = invoked.length;

      const redriven = yield* final.host.advance(RUN);

      expect(redriven).toStrictEqual(report);
      expect(invoked).toHaveLength(before);

      const state = Option.getOrThrow(yield* backend.readRun(RUN));

      yield* restartFromLog(bufferedRunStore(backend), state);

      const replayed = yield* final.host.advance(RUN);

      expect(invoked).toHaveLength(before);
      expect(replayed.status).toBe("done");
      expect(replayed.value).toBe(report.value);
      expect(replayed.docs).toStrictEqual(report.docs);
    }),
  { arbitrary: { runs: 150 } }
);
