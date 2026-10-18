import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { EnabledStepKinds } from "../../src/plans/step-kinds.js";
import { CompletionLost } from "../../src/runs/completion-lost.js";
import { RunHost } from "../../src/runs/host.js";
import {
  bufferedRunStore,
  memoryRunBackend,
  RunStore,
  withinRun,
} from "../../src/runs/run-store.js";
import type { RunBackend } from "../../src/runs/run-store.js";
import { RunStateSchema } from "../../src/runs/schema.js";
import type { RunReport, RunState } from "../../src/runs/schema.js";
import { CallRegistry, callable } from "../../src/steps/call-registry.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";

const RUN = "wide";

const KIB = 1024;

const CHECKPOINT_FLOOR = 64 * KIB;

const PER_BRANCH = KIB;

const SizeSchema = Schema.Literals([0, KIB, 64 * KIB, 192 * KIB]);

const InterruptionSchema = Schema.Struct({
  at: Schema.Int.check(Schema.isBetween({ maximum: 14, minimum: 1 })),
  kind: Schema.Literals([
    "crash",
    "crashAfterStep",
    "crashBeforeCommit",
    "crashInStep",
  ]),
});

type Interruption = typeof InterruptionSchema.Type;

const WorldArbitrary = Arbitrary.all({
  branches: Arbitrary.array(Arbitrary.schema(SizeSchema), {
    maxLength: 12,
    minLength: 2,
  }),
  calls: Arbitrary.array(Arbitrary.schema(SizeSchema), { maxLength: 3 }),
  interruptions: Arbitrary.array(Arbitrary.schema(InterruptionSchema), {
    maxLength: 3,
  }),
});

type World =
  typeof WorldArbitrary extends Arbitrary.Arbitrary<infer A> ? A : never;

const thoughtOf = (index: number, size: number) =>
  `think ${index}:${"t".repeat(size)}`;

const calledOf = (index: number, size: number) =>
  `call ${index}:${"c".repeat(size)}`;

const callAt = (index: number) => `call_${index}`;

const callsOf = (calls: readonly number[]) =>
  Object.fromEntries(
    calls.map((_, index) => [
      callAt(index),
      {
        meta: {
          step: {
            capability: "blob",
            input: { index },
            kind: "call",
            writes: `called_${index}`,
          },
        },
        on: {
          done: {
            target: index + 1 < calls.length ? callAt(index + 1) : "done",
          },
        },
      },
    ])
  );

const planOf = ({ branches, calls }: World) => ({
  defaults: { agent: { model: "sol" } },
  envelope: {
    maxAgents: branches.length,
    maxDepth: 3,
    maxSteps: 2 * branches.length + calls.length + 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: `Run ${branches.length} branches at once`,
  id: "wide",
  machine: {
    id: "wide",
    initial: "fan",
    states: {
      ...callsOf(calls),
      done: { type: "final" },
      fan: {
        meta: {
          step: {
            branches: Object.fromEntries(
              branches.map((_, index) => [
                `b${index}`,
                {
                  initial: "work",
                  states: {
                    done: { type: "final" },
                    gate: {
                      meta: {
                        step: {
                          cases: {},
                          default: "pass",
                          kind: "switch",
                          reads: `out_${index}`,
                        },
                      },
                      on: { pass: { target: "done" } },
                    },
                    work: {
                      meta: {
                        step: {
                          kind: "think",
                          prompt: `p${index}`,
                          writes: `out_${index}`,
                        },
                      },
                      on: { done: { target: "gate" } },
                    },
                  },
                },
              ])
            ),
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: { done: { target: calls.length > 0 ? callAt(0) : "done" } },
      },
    },
  },
});

interface Ledger {
  readonly atCrash: Map<string, number>;
  readonly invoked: string[];
  largest: number;
}

const encodeRow = (state: RunState) =>
  Schema.encodeEffect(Schema.fromJsonString(RunStateSchema))(state).pipe(
    Effect.orDie
  );

const committedSteps = (backend: RunBackend) =>
  backend
    .readJournal(RUN)
    .pipe(
      Effect.map((journal) =>
        [...journal.keys()].filter((key) => key.startsWith("logic:"))
      )
    );

const incarnation = (
  backend: RunBackend,
  world: World,
  ledger: Ledger,
  interruption?: Interruption
) =>
  Effect.gen(function* oneProcess() {
    const victim = yield* Deferred.make<Fiber.Fiber<RunReport, unknown>>();
    const counters = { dead: false, saves: 0, steps: 0 };
    const mine: string[] = [];
    const base = bufferedRunStore(backend);

    const die = Effect.gen(function* crash() {
      counters.dead = true;
      const committed = yield* committedSteps(backend);

      for (const id of new Set(mine)) {
        if (!committed.some((key) => key.endsWith(`.${id}`))) {
          ledger.atCrash.set(id, (ledger.atCrash.get(id) ?? 0) + 1);
        }
      }

      const fiber = yield* Deferred.await(victim);
      yield* Effect.forkDetach(Fiber.interrupt(fiber));

      return yield* Effect.never;
    });

    const invoke = (key: string, visit: number, output: string) =>
      Effect.suspend(() => {
        if (counters.dead) {
          return Effect.never;
        }

        mine.push(`${key}#${visit}`);
        ledger.invoked.push(`${key}#${visit}`);

        return Effect.succeed(output);
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
        Effect.gen(function* recordedWrite() {
          yield* counters.dead ? Effect.never : Effect.void;

          const row = yield* encodeRow(state);

          ledger.largest = Math.max(ledger.largest, row.length);
          counters.saves += 1;
          yield* base.writeRun(runId, state);

          const here = counters.saves === interruption?.at;

          if (here && interruption.kind === "crash") {
            yield* base.commit(runId);
          }

          const crashing =
            here &&
            (interruption.kind === "crash" ||
              interruption.kind === "crashBeforeCommit");

          yield* crashing ? die : Effect.void;
        }),
    });

    const thinker = Thinker.of({
      decide: () => Effect.die("no judge in this plan"),
      elaborate: () => Effect.die("no elaborate in this plan"),
      think: ({ key, prompt, visit }) => {
        const index = Number(prompt.slice(1));
        const size = world.branches[index];

        return size === undefined
          ? Effect.die(`no branch ${index}`)
          : invoke(key, visit, thoughtOf(index, size)).pipe(
              Effect.map((output) => ({ output, tokens: 1 }))
            );
      },
    });

    const blob = callable({
      input: Schema.Struct({ index: Schema.Int }),
      output: Schema.String,
      run: ({ index }, { key, visit }) => {
        const size = world.calls[index];

        return size === undefined
          ? Effect.die(`no call ${index}`)
          : invoke(key, visit, calledOf(index, size));
      },
    });

    const host = yield* RunHost.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Judge.unwired,
          Mail.unwired,
          Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
        )
      ),
      Effect.provideService(RunStore, store),
      Effect.provideService(Thinker, thinker),
      Effect.provideService(CallRegistry, new Map([["blob", blob]])),
      Effect.provideService(EnabledStepKinds, new Set(["call"] as const))
    );

    const work = Effect.gen(function* drive() {
      const submitted = Option.isSome(yield* backend.readRun(RUN));

      return submitted
        ? yield* host.resume(RUN)
        : yield* host.submit(RUN, planOf(world));
    });

    const fiber = yield* Effect.forkChild(work);
    yield* Deferred.succeed(victim, fiber);

    return yield* Effect.exit(Fiber.join(fiber));
  });

it.effect.prop(
  "a wide parallel step and the calls after it, under any crash schedule, end with every step's output, repeats only steps running at a crash, and never saves a checkpoint that grows with output size",
  { world: WorldArbitrary },
  ({ world }) =>
    Effect.gen(function* property() {
      const backend = memoryRunBackend();
      const ledger: Ledger = { atCrash: new Map(), invoked: [], largest: 0 };

      for (const interruption of world.interruptions) {
        yield* incarnation(backend, world, ledger, interruption);
      }

      const last = yield* incarnation(backend, world, ledger);
      const report: RunReport = yield* last;

      expect({
        docs: report.docs,
        status: report.status,
        value: report.value,
      }).toStrictEqual({
        docs: Object.fromEntries([
          ...world.branches.map(
            (size, index) => [`out_${index}`, thoughtOf(index, size)] as const
          ),
          ...world.calls.map(
            (size, index) => [`called_${index}`, calledOf(index, size)] as const
          ),
        ]),
        status: "done",
        value: "done",
      });

      const counts = new Map<string, number>();

      for (const id of ledger.invoked) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }

      expect(counts.size).toBe(world.branches.length + world.calls.length);

      for (const [id, times] of counts) {
        expect(
          times,
          `${id} ran ${times} times; only a crash that caught it running may repeat it`
        ).toBeLessThanOrEqual(1 + (ledger.atCrash.get(id) ?? 0));
      }

      expect(
        ledger.largest,
        "the largest checkpoint row must not grow with step output size"
      ).toBeLessThanOrEqual(
        CHECKPOINT_FLOOR + PER_BRANCH * world.branches.length
      );
    }),
  { arbitrary: { runs: 200 }, timeout: 120_000 }
);

const quietServices = Layer.mergeAll(
  NodeCrypto.layer,
  Judge.unwired,
  Mail.unwired,
  Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
);

const hostOn = (backend: RunBackend, saved: RunState[]) =>
  Effect.gen(function* recordingHost() {
    const base = bufferedRunStore(backend);

    return yield* RunHost.make.pipe(
      Effect.provide(quietServices),
      Effect.provideService(
        RunStore,
        RunStore.of({
          ...base,
          writeRun: (runId, state) =>
            Effect.sync(() => saved.push(state)).pipe(
              Effect.andThen(base.writeRun(runId, state))
            ),
        })
      ),
      Effect.provideService(
        Thinker,
        Thinker.of({
          decide: () => Effect.die("no judge in this plan"),
          elaborate: () => Effect.die("no elaborate in this plan"),
          think: ({ prompt }) =>
            Effect.succeed({ output: `answer to ${prompt}`, tokens: 1 }),
        })
      )
    );
  });

it.effect(
  "a checkpoint whose completion names a journal row that is gone stops the run with CompletionLost instead of resuming without the output",
  () =>
    Effect.gen(function* lostRow() {
      const backend = memoryRunBackend();
      const saved: RunState[] = [];
      const first = yield* hostOn(backend, saved);

      const done = yield* first.submit(
        RUN,
        planOf({ branches: [0, 0, 0], calls: [], interruptions: [] })
      );

      expect(done.status).toBe("done");

      const [held, lost] = saved.flatMap((state) =>
        (state.checkpoint?.mailbox ?? []).flatMap(({ outputAt }) =>
          outputAt === undefined ? [] : [[state, outputAt] as const]
        )
      )[0] ?? [undefined, undefined];

      expect(lost).toMatch(/^logic:/u);

      if (held === undefined || lost === undefined) {
        return;
      }

      const store = bufferedRunStore(backend);

      yield* withinRun(store, RUN)(store.writeRun(RUN, held));

      const second = yield* hostOn(
        {
          ...backend,
          readJournal: (runId) =>
            backend
              .readJournal(runId)
              .pipe(
                Effect.map(
                  (journal) =>
                    new Map([...journal].filter(([key]) => key !== lost))
                )
              ),
        },
        []
      );

      const exit = yield* Effect.exit(second.advance(RUN));

      expect(Exit.isFailure(exit)).toBe(true);

      const defect = Exit.isFailure(exit)
        ? Cause.squash(exit.cause)
        : undefined;

      expect(Schema.is(CompletionLost)(defect)).toBe(true);
      expect(defect).toMatchObject({ key: lost, runId: RUN });
    })
);
