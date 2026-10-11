import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option, Random, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { decodePlan } from "../../src/plans/schema.js";
import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import { RunStateSchema } from "../../src/runs/schema.js";
import type { RunReport } from "../../src/runs/schema.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { StepFailed } from "../../src/steps/step-failed.js";
import { Thinker } from "../../src/steps/thinker.js";
import {
  launchNoteAmendment,
  launchNotePlan,
  launchNoteSeed,
} from "./launch-note.js";
import { docsSeen, simulate, toJson } from "./plan-model.js";
import type { Fixture, Fixtures, ModelCall } from "./plan-model.js";

const RUN = "prop-run";

const JEV_TOKENS = 7;

const THINK_TOKENS = 11;

const rungTokens = (rung: string) => {
  if (rung === "jev") {
    return JEV_TOKENS;
  }

  return rung === "think" ? THINK_TOKENS : 0;
};

const JudgedEntrySchema = Schema.Struct({
  ladder: Schema.NonEmptyArray(
    Schema.Struct({
      rung: Schema.String,
      usage: Schema.optionalKey(Schema.Struct({ tokens: Schema.Finite })),
    })
  ),
  tokens: Schema.Finite,
});

const decodeJudged = Schema.decodeUnknownOption(JudgedEntrySchema);

const WIDTH = 2;

const BRANCH_STEPS = [
  "research.product.gather",
  "research.product.summarize",
  "research.audience.gather",
] as const;

const Judgement = Schema.Struct({
  fallback: Schema.optionalKey(
    Schema.Struct({
      confidence: Schema.Literals([0.3, 0.9]),
      pickFirst: Schema.Boolean,
    })
  ),
  lean: Schema.Literals([0.05, 0.5, 0.95]),
});

const InterruptionSchema = Schema.Struct({
  at: Schema.Int.check(Schema.isBetween({ maximum: 16, minimum: 1 })),
  kind: Schema.Literals(["cancel", "crash", "crashInStep", "pause"]),
});

type Interruption = typeof InterruptionSchema.Type;

const judgements = Arbitrary.array(Arbitrary.schema(Judgement), {
  maxLength: 12,
  minLength: 12,
});

const WorldArbitrary = Arbitrary.all({
  assess: judgements,
  extensions: Arbitrary.array(
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 1 }))
    ),
    { maxLength: 3 }
  ),
  failures: Arbitrary.array(
    Arbitrary.array(Arbitrary.schema(Schema.Literals([0, 1, 2, 3])), {
      maxLength: 12,
      minLength: 12,
    }),
    { maxLength: 3, minLength: 3 }
  ),
  fallback: Arbitrary.schema(Schema.Literals(["none", "enough", "thin"])),
  interruptions: Arbitrary.array(Arbitrary.schema(InterruptionSchema), {
    maxLength: 4,
  }),
  join: Arbitrary.schema(Schema.Literals(["allSettled", "failFast"])),
  maxSteps: Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ maximum: 40, minimum: 2 }))
  ),
  publishAnswers: Arbitrary.array(
    Arbitrary.schema(Schema.Literals(["approve", "hold"])),
    { maxLength: 3 }
  ),
  shipAnswers: Arbitrary.array(
    Arbitrary.schema(Schema.Literals(["ship", "revise"])),
    { maxLength: 6 }
  ),
  shipCheck: judgements,
  thinkThreshold: Arbitrary.schema(Schema.Literals(["none", 0.5, 0.95])),
});

type World =
  typeof WorldArbitrary extends Arbitrary.Arbitrary<infer A> ? A : never;

const fixturesFor = (world: World): Fixtures => {
  const fixtures: Record<string, Fixture> = {};

  const judge = (
    key: string,
    [first, second]: readonly [string, string],
    list: World["assess"]
  ) => {
    for (const [index, { fallback, lean }] of list.entries()) {
      fixtures[`${key}#${index + 1}`] = {
        probs: { [first]: lean, [second]: 1 - lean },
      };

      if (fallback !== undefined) {
        fixtures[`${key}#${index + 1}:think`] = {
          choice: fallback.pickFirst ? first : second,
          confidence: fallback.confidence,
        };
      }
    }
  };

  judge("assess", ["enough", "thin"], world.assess);
  judge("ship_check", ["ship", "revise"], world.shipCheck);

  for (const [index, answer] of world.shipAnswers.entries()) {
    fixtures[`ship_check#${index + 1}:joel`] = { answer };
  }

  for (const [index, answer] of world.publishAnswers.entries()) {
    fixtures[`publish#${index + 1}:joel`] = { answer };
  }

  for (const [index, key] of BRANCH_STEPS.entries()) {
    for (const [visit, roll] of (world.failures[index] ?? []).entries()) {
      fixtures[`${key}#${visit + 1}`] =
        roll === 0 ? { fail: true } : { output: `${key} v${visit + 1}` };
    }
  }

  for (let visit = 1; visit <= 30; visit += 1) {
    fixtures[`draft.write#${visit}`] = { output: `draft v${visit}` };
    fixtures[`draft.review#${visit}`] = { reply: `review ${visit}` };
    fixtures[`draft#${visit}`] = { amendment: launchNoteAmendment };
  }

  return fixtures;
};

const planFor = (world: World) => {
  const { assess, research } = launchNotePlan.machine.states;

  return {
    ...launchNotePlan,
    envelope: {
      ...launchNotePlan.envelope,
      maxSteps: world.maxSteps,
      thresholds:
        world.thinkThreshold === "none"
          ? launchNotePlan.envelope.thresholds
          : {
              ...launchNotePlan.envelope.thresholds,
              think: world.thinkThreshold,
            },
    },
    machine: {
      ...launchNotePlan.machine,
      states: {
        ...launchNotePlan.machine.states,
        assess:
          world.fallback === "none"
            ? assess
            : {
                ...assess,
                meta: {
                  step: { ...assess.meta.step, fallback: world.fallback },
                },
              },
        research: {
          ...research,
          meta: { step: { ...research.meta.step, join: world.join } },
        },
      },
    },
  };
};

const withLimit = (plan: ReturnType<typeof planFor>, maxSteps: number) => ({
  ...plan,
  envelope: { ...plan.envelope, maxSteps },
});

const limitsFor = (world: World) => {
  const limits: number[] = [];
  let limit = world.maxSteps;

  for (const extra of world.extensions) {
    limit += extra;
    limits.push(limit);
  }

  return limits;
};

const outcome = <A>(key: string, found: Fixture, value: A) =>
  found.fail === true
    ? Effect.fail(new StepFailed({ key, reason: "fixture failure" }))
    : Effect.succeed(value);

const fakes = (fixtures: Fixtures, calls: ModelCall[], announced: string[]) => {
  const fixture = (key: string, visit: number, suffix = "") =>
    fixtures[`${key}#${visit}${suffix}`] ?? {};

  const record = (key: string, kind: string, visit: number) =>
    Effect.sync(() => {
      calls.push({ key, kind, visit });
    });

  return {
    judge: Judge.of({
      choose: ({ docs, key, options, visit }) =>
        Effect.sync(() => {
          calls.push({ docs: docsSeen(docs), key, kind: "jev", visit });

          return {
            probabilities:
              fixture(key, visit).probs ??
              Object.fromEntries(
                options.map((option) => [option, 1 / options.length])
              ),
            usage: { tokens: JEV_TOKENS },
          };
        }),
    }),
    mail: Mail.of({
      seal: ({ key, visit }) =>
        Random.next.pipe(
          Effect.map((nonce) => ({
            envelope: `${key}#${visit} ${nonce}`,
            messageId: `${key}#${visit}`,
          }))
        ),
      send: ({ key, visit }) =>
        record(key, "ask", visit).pipe(
          Effect.andThen(() =>
            outcome(key, fixture(key, visit), null).pipe(Effect.asVoid)
          )
        ),
    }),
    operator: Operator.of({
      notify: (_runId, { key }) =>
        Effect.sync(() => {
          announced.push(key);
        }),
    }),
    thinker: Thinker.of({
      decide: ({ key, visit }) =>
        record(key, "think-fallback", visit).pipe(
          Effect.as({
            decision: Option.flatMap(
              Option.fromUndefinedOr(fixtures[`${key}#${visit}:think`]),
              ({ choice, confidence }) =>
                choice === undefined
                  ? Option.none()
                  : Option.some({ choice, confidence: confidence ?? 0 })
            ),
            usage: { tokens: THINK_TOKENS },
          })
        ),
      elaborate: ({ key, visit }) =>
        record(key, "elaborate", visit).pipe(
          Effect.as({
            amendment: toJson(fixture(key, visit).amendment ?? null),
            tokens: 0,
          })
        ),
      think: ({ key, prompt, visit }) =>
        record(key, "think", visit).pipe(
          Effect.andThen(() => {
            const found = fixture(key, visit);

            return outcome(key, found, {
              output: found.output ?? `(${prompt})`,
              tokens: 0,
            });
          })
        ),
    }),
  };
};

const expectAnnounced = (
  announced: readonly string[],
  question: { readonly answered: number; readonly key: string },
  crashes: number
) => {
  const times = announced.filter((key) => key === question.key).length;

  expect(times).toBeGreaterThanOrEqual(question.answered + 1);
  expect(times).toBeLessThanOrEqual(question.answered + 1 + crashes);
};

const incarnation = (
  base: (typeof RunStore)["Service"],
  fixtures: Fixtures,
  calls: ModelCall[],
  announced: string[],
  script: { readonly limits: readonly number[]; readonly plan: Schema.Json },
  first: boolean,
  interruption?: Interruption
) =>
  Effect.gen(function* oneProcess() {
    const { limits, plan } = script;
    const victim = yield* Deferred.make<Fiber.Fiber<RunReport, unknown>>();

    const counters = {
      dead: false,
      pausedWhileRunning: false,
      saves: 0,
      steps: 0,
    };

    const stop = (dead: boolean) =>
      Effect.gen(function* stopProcess() {
        counters.dead = dead;
        const fiber = yield* Deferred.await(victim);
        yield* Effect.forkDetach(Fiber.interrupt(fiber));

        return yield* Effect.never;
      });

    const die = stop(true);

    const store = RunStore.of({
      ...base,
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

          return key.startsWith("logic:") &&
            interruption?.kind === "crashInStep" &&
            counters.steps === interruption.at
            ? die
            : base.writeJournal(runId, key, entry);
        }),
      writePlan: (runId, next) =>
        counters.dead ? Effect.never : base.writePlan(runId, next),
      writeRun: (runId, state) =>
        Effect.suspend(() => {
          if (counters.dead) {
            return Effect.never;
          }

          counters.saves += 1;
          const written = base.writeRun(runId, state);

          if (counters.saves !== interruption?.at) {
            return written;
          }

          if (interruption.kind === "crash") {
            return written.pipe(Effect.andThen(die));
          }

          if (interruption.kind === "cancel") {
            return written.pipe(Effect.andThen(stop(false)));
          }

          if (interruption.kind === "pause") {
            counters.pausedWhileRunning =
              state.status === "running" && state.checkpoint !== null;

            return written.pipe(Effect.andThen(base.writePaused(runId, true)));
          }

          return written;
        }),
    });

    const { judge, mail, operator, thinker } = fakes(
      fixtures,
      calls,
      announced
    );

    const host = yield* RunHost.make.pipe(
      Effect.provideService(RunStore, store),
      Effect.provideService(Thinker, thinker),
      Effect.provideService(Judge, judge),
      Effect.provideService(Mail, mail),
      Effect.provideService(Operator, operator)
    );

    const pastEnvelope = (report: RunReport) =>
      Effect.gen(function* holdThenExtend() {
        expect(
          (report.awaiting ?? []).map(({ key }) => `${key}__reply`)
        ).toEqual(
          report.value?.endsWith("__reply") === true ? [report.value] : []
        );

        const [pending] = report.awaiting ?? [];

        const early =
          pending === undefined
            ? undefined
            : fixtures[pending.messageId]?.reply;

        if (pending !== undefined && early !== undefined) {
          const held = yield* host.deliver({
            body: early,
            from: pending.to,
            replyTo: pending.messageId,
          });

          expect(held.status).toBe("envelope-exceeded");
          expect(held.awaiting).toEqual(report.awaiting);
        }

        const current = yield* store.readPlan(RUN, report.planVersion);

        const limit = Option.match(current, {
          onNone: () => Number.POSITIVE_INFINITY,
          onSome: ({ envelope }) => envelope.maxSteps,
        });

        const next = limits.find((candidate) => candidate > limit);

        return next === undefined
          ? Option.none<RunReport>()
          : Option.some(yield* host.extend(RUN, next));
      });

    const work = Effect.gen(function* work() {
      let report = first
        ? yield* host.submit(RUN, plan, launchNoteSeed)
        : yield* host.resume(RUN);

      for (;;) {
        if (report.status === "envelope-exceeded") {
          const extended = yield* pastEnvelope(report);

          if (Option.isNone(extended)) {
            break;
          }

          report = extended.value;

          continue;
        }

        const [open] = report.awaiting ?? [];

        if (report.status === "waiting-for-reply" && open !== undefined) {
          const body = fixtures[open.messageId]?.reply;

          if (body === undefined) {
            break;
          }

          report = yield* host.deliver({
            acceptedAt: "2026-10-11T00:00:00Z",
            body,
            from: open.to,
            messageId: `reply:${open.messageId}`,
            replyTo: open.messageId,
          });

          continue;
        }

        if (report.status !== "waiting-for-joel" || !report.question) {
          break;
        }

        expectAnnounced(announced, report.question, Number.POSITIVE_INFINITY);

        const { answered, key, options } = report.question;
        const reply = fixtures[`${key}#${answered + 1}:joel`]?.answer;

        if (reply === undefined || !options.includes(reply)) {
          break;
        }

        report = yield* host.answer(RUN, reply);
      }

      return report;
    });

    const fiber = yield* Effect.forkChild(work);
    yield* Deferred.succeed(victim, fiber);
    const exit = yield* Effect.exit(Fiber.join(fiber));

    return { exit, pausedWhileRunning: counters.pausedWhileRunning };
  });

const callId = ({ docs, key, kind, visit }: ModelCall) =>
  `${key} ${kind} ${visit} ${docs ?? ""}`;

const firstOccurrences = (calls: readonly ModelCall[]) => [
  ...new Set(calls.map(callId)),
];

const stepStarts = (calls: readonly ModelCall[]) =>
  calls.filter((call) => call.kind !== "think-fallback").length;

it.effect.prop(
  "any schedule of crashes and pauses ends where the plan model ends, and only steps running at a crash repeat",
  { world: WorldArbitrary },
  ({ world }) =>
    Effect.gen(function* property() {
      const plan = planFor(world);
      const fixtures = fixturesFor(world);
      const limits = limitsFor(world);
      let expected = simulate(plan, fixtures, launchNoteSeed);

      for (const limit of limits) {
        if (expected.status !== "envelope-exceeded") {
          break;
        }

        expected = simulate(withLimit(plan, limit), fixtures, launchNoteSeed);
      }

      const base = yield* Effect.provide(
        Effect.service(RunStore),
        RunStore.memory
      );

      const calls: ModelCall[] = [];
      const announced: string[] = [];
      let first = true;

      for (const interruption of world.interruptions) {
        const { exit, pausedWhileRunning } = yield* incarnation(
          base,
          fixtures,
          calls,
          announced,
          { limits, plan },
          first,
          interruption
        );

        first = false;

        if (pausedWhileRunning) {
          expect(Exit.isSuccess(exit) && exit.value.status).toBe("paused");
        }
      }

      const final = yield* incarnation(
        base,
        fixtures,
        calls,
        announced,
        { limits, plan },
        first
      );

      const actual = yield* final.exit;

      if (actual.status === "envelope-exceeded") {
        expect(announced).toContain("__envelope");
      }

      if (actual.question !== undefined) {
        expectAnnounced(
          announced,
          actual.question,
          world.interruptions.filter(({ kind }) => kind !== "pause").length
        );
      }

      const state = yield* base.readRun(RUN);
      yield* Schema.decodeEffect(RunStateSchema)(Option.getOrThrow(state));
      const stored = yield* base.readPlan(RUN, actual.planVersion);
      yield* decodePlan(Option.getOrThrow(stored));

      expect({
        docs: actual.docs,
        status: actual.status,
        transitions: actual.transitions,
        value: actual.value,
      }).toEqual({
        docs: expected.docs,
        status: expected.status,
        transitions: expected.transitions,
        value: expected.value,
      });
      expect(firstOccurrences(calls)).toEqual(expected.calls.map(callId));

      const journal = yield* base.readJournal(RUN);

      const judged = [...journal.values()].flatMap((entry) =>
        Option.toArray(decodeJudged(entry))
      );

      expect(judged.length > 0).toBe(
        expected.calls.some(({ kind }) => kind === "jev")
      );

      for (const { ladder, tokens } of judged) {
        const spent = ladder.map(({ rung }) => rungTokens(rung));

        expect(ladder.map(({ usage }) => usage?.tokens ?? 0)).toEqual(spent);
        expect(tokens).toBe(spent.reduce<number>((sum, used) => sum + used, 0));
      }

      const crashesInStep = world.interruptions.filter(
        ({ kind }) => kind === "crashInStep" || kind === "cancel"
      ).length;

      expect(
        stepStarts(calls) - stepStarts(expected.calls)
      ).toBeLessThanOrEqual(crashesInStep * WIDTH);
    }),
  { arbitrary: { runs: 600 }, timeout: 20_000 }
);
