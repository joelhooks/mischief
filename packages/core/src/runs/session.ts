import { Effect, Option, Result, Schema } from "effect";
import { constVoid } from "effect/Function";
import { createAsyncLogic } from "xstate";
import type { AnyEventObject, Snapshot } from "xstate";

import { amendPlan } from "../plans/amend.js";
import type { AmendPoint } from "../plans/amend.js";
import { AMENDED, compilePlan, planFacts } from "../plans/compile.js";
import type { Ask } from "../plans/compile.js";
import { decodeAmendment } from "../plans/schema.js";
import type { Plan } from "../plans/schema.js";
import { checkPlan, refuseCode } from "../plans/validate.js";
import {
  AskInputSchema,
  ElaborateInputSchema,
  JudgeInputSchema,
  OutputEventSchema,
  ThinkInputSchema,
} from "../steps/inputs.js";
import type {
  AskInput,
  ElaborateInput,
  JudgeInput,
  JudgeVerdict,
  ThinkInput,
} from "../steps/inputs.js";
import { Judge } from "../steps/judge.js";
import { Mail } from "../steps/mail.js";
import { Operator } from "../steps/operator.js";
import { StepFailed } from "../steps/step-failed.js";
import { Thinker } from "../steps/thinker.js";
import { describeValue, leaves, openExecution } from "./execution.js";
import type { Adapter, Execution, Sources } from "./execution.js";
import { RunStore } from "./run-store.js";
import type { QueuedEvent, RunReport, RunState, RunStatus } from "./schema.js";

export type StepServices = Judge | Mail | Operator | RunStore | Thinker;

type Choice =
  | { readonly kind: "event"; readonly event: QueuedEvent }
  | { readonly kind: "halt"; readonly status: RunStatus };

const DRAINED = { type: "mischief.drained" };

const decodeFailure = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.String })
);

const decodeVerdict = Schema.decodeUnknownOption(OutputEventSchema);

const decodeOutput = Schema.decodeUnknownEffect(Schema.Json);

const decodeIdentity = Schema.decodeUnknownOption(
  Schema.Struct({ machine: Schema.Struct({ id: Schema.String }) })
);

const failed = (key: string, reason: string) => new StepFailed({ key, reason });

const verdictOf = (event: AnyEventObject): JudgeVerdict =>
  Option.match(decodeVerdict(event), {
    onNone: () => ({}),
    onSome: ({ output }) => output,
  });

const migrateTo = (persisted: Snapshot<unknown>, plan: Plan) => {
  const version = String(plan.version);

  const id = Option.match(decodeIdentity(persisted), {
    onNone: () => plan.machine.id,
    onSome: ({ machine }) => machine.id,
  });

  const identity = { machine: { id, version }, version };

  const migrated: Snapshot<unknown> = { ...persisted, ...identity };

  return migrated;
};

export const reportOf = (runId: string, plan: Plan, state: RunState) =>
  Effect.gen(function* buildReport() {
    const store = yield* RunStore;

    const report: RunReport = {
      docs: yield* store.readDocs(runId),
      planId: plan.id,
      planVersion: state.planVersion,
      runId,
      status: state.status,
      transitions: state.transitions,
      value: state.value,
    };

    if (state.status !== "waiting-for-joel" || state.asking === null) {
      return report;
    }

    return {
      ...report,
      question: {
        ...state.asking,
        answered: state.answers[state.asking.key] ?? 0,
      },
    } satisfies RunReport;
  });

export const driveSession = (
  runId: string,
  opened: { readonly plan: Plan; readonly state: RunState },
  firstReply: string | undefined
) =>
  Effect.gen(function* runSession() {
    const store = yield* RunStore;
    const thinker = yield* Thinker;
    const judge = yield* Judge;
    const mail = yield* Mail;
    const operator = yield* Operator;

    const runPromise = Effect.runPromiseWith(
      yield* Effect.context<StepServices>()
    );

    const journal = new Map(yield* store.readJournal(runId));
    const mailbox: QueuedEvent[] = [];
    const pending = new Map<symbol, Promise<Schema.Json>>();
    const visits = new Map<string, number>();

    const starts = new Map(
      Object.entries(opened.state.checkpoint?.starts ?? {})
    );

    const answers = new Map(Object.entries(opened.state.answers));

    const run = {
      facts: planFacts(opened.plan),
      plan: opened.plan,
      reply: firstReply,
      state: opened.state,
    };

    const journaled = (
      key: string,
      exec: Effect.Effect<Schema.Json, StepFailed>
    ) =>
      Effect.gen(function* replayOrRun() {
        const hit = journal.get(key);

        if (hit !== undefined) {
          const failure = decodeFailure(hit);

          return Option.isSome(failure)
            ? yield* failed(key, failure.value.error)
            : hit;
        }

        const outcome = yield* Effect.result(exec);

        const entry = Result.isSuccess(outcome)
          ? outcome.success
          : { error: outcome.failure.reason };

        journal.set(key, entry);
        yield* store.writeJournal(runId, key, entry);

        return Result.isSuccess(outcome)
          ? outcome.success
          : yield* outcome.failure;
      });

    const visitOf = (key: string) => visits.get(key) ?? 1;

    const step = <A>(key: string, effect: Effect.Effect<A, StepFailed>) =>
      effect.pipe(
        Effect.tapError(() => store.writeDoc(runId, `failed:${key}`, true))
      );

    const writeDoc = (name: string | undefined, doc: Schema.Json) =>
      name === undefined ? Effect.void : store.writeDoc(runId, name, doc);

    const think = (input: ThinkInput) =>
      Effect.gen(function* thinkStep() {
        const thought = yield* step(
          input.key,
          thinker.think({
            agent: input.agent ?? {},
            key: input.key,
            prompt: input.prompt,
            runId,
            visit: visitOf(input.key),
          })
        );

        yield* writeDoc(input.writes, thought.output);

        return { output: thought.output, tokens: thought.tokens };
      });

    const ask = (input: AskInput) =>
      Effect.gen(function* askStep() {
        const answer = yield* step(
          input.key,
          mail.ask({
            key: input.key,
            message: input.message,
            runId,
            to: input.to,
            visit: visitOf(input.key),
          })
        );

        yield* writeDoc(input.writes, answer);

        return { output: answer, tokens: 0 };
      });

    const elaborate = (input: ElaborateInput) =>
      Effect.gen(function* elaborateStep() {
        const result = yield* step(
          input.key,
          thinker.elaborate({
            goal: input.goal,
            key: input.key,
            runId,
            visit: visitOf(input.key),
          })
        );

        yield* writeDoc(`__amendment:${input.key}`, result.amendment);

        return { amendment: result.amendment, tokens: result.tokens };
      });

    const decide = (input: JudgeInput) =>
      Effect.gen(function* decideStep() {
        const call = {
          key: input.key,
          options: input.options,
          question: input.question,
          runId,
          visit: visitOf(input.key),
        };

        const stored = yield* store.readDocs(runId);

        const docs = Object.fromEntries(
          (input.reads ?? []).flatMap((name) =>
            name in stored ? [[name, stored[name] ?? null]] : []
          )
        );

        const { probabilities, usage } = yield* step(
          input.key,
          judge.choose({ ...call, docs })
        );

        const [top] = Object.entries(probabilities).toSorted(
          (left, right) => right[1] - left[1]
        );

        const jev = { probs: probabilities, rung: "jev", usage: { ...usage } };

        if (top !== undefined && top[1] >= (input.threshold ?? 1)) {
          return { choice: top[0], ladder: [jev], tokens: usage.tokens };
        }

        const decision = yield* step(input.key, thinker.decide(call));

        const rung = Option.match(decision, {
          onNone: () => ({ rung: "think" }),
          onSome: ({ choice, confidence }) => ({
            choice,
            confidence,
            rung: "think",
          }),
        });

        const confident = decision.pipe(
          Option.filter(
            ({ choice, confidence }) =>
              confidence >= 0.6 && input.options.includes(choice)
          )
        );

        return Option.isSome(confident)
          ? {
              choice: confident.value.choice,
              ladder: [jev, rung],
              tokens: usage.tokens + 800,
            }
          : { escalate: true, ladder: [jev, rung], tokens: usage.tokens + 800 };
      });

    const logic = <I>(
      schema: Schema.Decoder<I>,
      body: (input: I) => Effect.Effect<Schema.Json, StepFailed>
    ) =>
      createAsyncLogic({
        // oxlint-disable-next-line typescript/promise-function-async -- xstate async logic consumes a Promise factory.
        run: ({ input }: { readonly input: Schema.Json }) =>
          runPromise(
            Schema.decodeEffect(schema)(input).pipe(
              Effect.mapError(() => failed("input", "step input refused")),
              Effect.flatMap(body)
            )
          ),
      });

    const sources: Sources = {
      actions: {
        askJoel: constVoid,
      },
      actors: {
        ask: logic(AskInputSchema, ask),
        elaborate: logic(ElaborateInputSchema, elaborate),
        judge: logic(JudgeInputSchema, decide),
        think: logic(ThinkInputSchema, think),
      },
      guards: {
        escalated: ({ event }: { readonly event: AnyEventObject }) =>
          verdictOf(event).escalate === true,
        picked: (
          { event }: { readonly event: AnyEventObject },
          { option }: { readonly option: string }
        ) => verdictOf(event).choice === option,
      },
    };

    const stepKeyOf = (address: string) => {
      const marker = `.${run.plan.machine.id}.`;
      const at = address.indexOf(marker);

      return at === -1 ? address : address.slice(at + marker.length);
    };

    // oxlint-disable-next-line typescript/promise-function-async -- runLogic must hand xstate the tracked Promise.
    const track = (
      key: string,
      work: Effect.Effect<Schema.Json, StepFailed>
    ) => {
      const token = Symbol(key);
      const settled = { done: false };

      const promise = runPromise(
        work.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              settled.done = true;
              pending.delete(token);
            })
          )
        )
      );

      if (!settled.done) {
        pending.set(token, promise);
      }

      return promise;
    };

    const adapter: Adapter = {
      enqueueRootEvent: (_source, event) => {
        mailbox.push(event);
      },
      // oxlint-disable-next-line typescript/promise-function-async -- the durable adapter awaits a Promise for each custom action.
      executeAction: (action, metadata) => {
        const key = `effect:${metadata.id}:${action.type}`;

        const exec = Effect.try({
          catch: (cause) => failed(key, String(cause)),
          try: () => action.exec?.(),
        }).pipe(Effect.as(true));

        return runPromise(journaled(key, exec).pipe(Effect.asVoid));
      },
      executionId: `${run.plan.id}:${runId}`,
      // oxlint-disable-next-line typescript/promise-function-async -- the durable adapter owns logic execution as a Promise.
      runLogic: (actor, exec) => {
        const visit = starts.get(actor.address) ?? 1;
        const key = `logic:${actor.address}#${visit}`;

        const work = Effect.tryPromise({
          catch: () => failed(key, `${key} failed`),
          // oxlint-disable-next-line typescript/promise-function-async -- xstate hands the step body over as a Promise factory.
          try: () => {
            visits.set(stepKeyOf(actor.address), visit);

            return Promise.resolve(exec());
          },
        }).pipe(
          Effect.flatMap((output) =>
            decodeOutput(output).pipe(
              Effect.mapError(() => failed(key, "step output is not JSON"))
            )
          )
        );

        return track(key, journaled(key, work));
      },
      waitForEvent: () => DRAINED,
    };

    const countStarts = (started: readonly string[]) => {
      for (const address of started) {
        starts.set(address, (starts.get(address) ?? 0) + 1);
      }
    };

    const { checkpoint } = opened.state;

    let execution: Execution = openExecution(
      compilePlan(run.plan),
      sources,
      adapter,
      {
        persisted: Option.fromNullOr(checkpoint).pipe(
          // SAFETY: the checkpoint snapshot was written by getPersistedSnapshot for this plan version.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          Option.map(({ snapshot }) => snapshot as Snapshot<unknown>)
        ),
        transitionIndex: checkpoint?.transitionIndex ?? 0,
      }
    );

    const factsHere = () =>
      leaves(execution.view().value).flatMap((path) => {
        const fact = run.facts.get(path.join("."));

        return fact === undefined ? [] : [fact];
      });

    const askHere = (): Ask | undefined =>
      factsHere().flatMap((fact) => (fact.kind === "ask" ? [fact.ask] : []))[0];

    const amendHere = (): AmendPoint | undefined =>
      factsHere().flatMap((fact) => (fact.kind === "amend" ? [fact] : []))[0];

    const fanoutOf = (path: readonly string[]) =>
      path
        .map((_, index) => path.slice(0, index + 1).join("."))
        .flatMap((key) => {
          const fact = run.facts.get(key);

          return fact?.kind === "fanout" ? [{ cost: fact.cost, key }] : [];
        })[0];

    const overCap = (before: readonly (readonly string[])[]) => {
      const entered = leaves(execution.view().value)
        .map((path) => fanoutOf(path))
        .find((fanout) => fanout !== undefined);

      if (
        entered === undefined ||
        before.some((path) => fanoutOf(path)?.key === entered.key)
      ) {
        return false;
      }

      return run.state.transitions + entered.cost > run.plan.envelope.maxSteps;
    };

    const report = Effect.suspend(() => reportOf(runId, run.plan, run.state));

    const save = (status: RunStatus) =>
      Effect.suspend(() => {
        run.state = {
          ...run.state,
          answers: Object.fromEntries(answers),
          asking: askHere() ?? null,
          checkpoint: {
            mailbox: structuredClone(mailbox),
            snapshot: execution.persist(),
            starts: Object.fromEntries(starts),
            transitionIndex: execution.nextTransitionIndex(),
          },
          status,
          value: describeValue(execution.view().value),
        };

        return store.writeRun(runId, run.state);
      });

    const mark = (status: RunStatus) =>
      Effect.suspend(() => {
        run.state = { ...run.state, status };

        return store.writeRun(runId, run.state).pipe(Effect.andThen(report));
      });

    const drain = Effect.gen(function* drainCaptured() {
      for (;;) {
        const event = yield* execution.next;

        if (event === DRAINED) {
          return;
        }

        mailbox.push(event);
      }
    });

    const dropStale = () => {
      const { children } = execution.view();

      const kept = mailbox.filter(
        ({ actorId }) =>
          actorId === undefined || children[actorId] !== undefined
      );

      mailbox.splice(0, mailbox.length, ...kept);
    };

    const nextEvent = Effect.gen(function* takeNextEvent() {
      for (;;) {
        yield* drain;
        yield* Effect.yieldNow;
        dropStale();

        const event = mailbox.shift();

        if (event !== undefined) {
          return Option.some(event);
        }

        if (pending.size === 0) {
          return Option.none<QueuedEvent>();
        }

        const inFlight = [...pending.values()];

        // oxlint-disable-next-line typescript/promise-function-async -- Effect.promise consumes a Promise factory directly.
        yield* Effect.promise(() => Promise.allSettled(inFlight));
      }
    });

    const choose = Effect.gen(function* chooseEvent() {
      const next = yield* nextEvent;

      if (Option.isSome(next)) {
        return { event: next.value, kind: "event" } satisfies Choice;
      }

      const question = askHere();

      if (question === undefined) {
        return { kind: "halt", status: "stuck" } satisfies Choice;
      }

      const chosen = run.reply;

      run.reply = undefined;

      if (chosen === undefined || !question.options.includes(chosen)) {
        const asked = (answers.get(question.key) ?? 0) + 1;

        yield* journaled(
          `announce:${question.key}#${asked}`,
          operator.notify(runId, question).pipe(Effect.as(true))
        ).pipe(Effect.ignore);

        return { kind: "halt", status: "waiting-for-joel" } satisfies Choice;
      }

      answers.set(question.key, (answers.get(question.key) ?? 0) + 1);

      return { event: { type: chosen }, kind: "event" } satisfies Choice;
    });

    const elaborated = (point: AmendPoint) =>
      Effect.gen(function* applyAmendment() {
        const docs = yield* store.readDocs(runId);
        const raw = docs[`__amendment:${point.path.join(".")}`] ?? null;

        const amendment = yield* refuseCode(raw).pipe(
          Effect.andThen(decodeAmendment(raw)),
          Effect.option
        );

        if (Option.isNone(amendment)) {
          return false;
        }

        const next = yield* checkPlan(
          amendPlan(run.plan, point, amendment.value)
        ).pipe(Effect.option);

        if (Option.isNone(next)) {
          return false;
        }

        run.plan = next.value;
        run.facts = planFacts(run.plan);
        yield* store.writePlan(runId, run.plan);

        execution = openExecution(compilePlan(run.plan), sources, adapter, {
          persisted: Option.some(migrateTo(execution.persist(), run.plan)),
          transitionIndex: execution.nextTransitionIndex(),
        });

        run.state = { ...run.state, planVersion: run.plan.version };
        yield* save("running");
        yield* execution.flush();

        return true;
      });

    const advance = (event: QueuedEvent) =>
      Effect.gen(function* advanceRun() {
        const before = leaves(execution.view().value);

        countStarts(execution.send(event));
        run.state = { ...run.state, transitions: run.state.transitions + 1 };

        const { status } = execution.view();

        if (
          status === "active" &&
          (run.state.transitions >= run.plan.envelope.maxSteps ||
            overCap(before))
        ) {
          yield* save("envelope-exceeded");

          return false;
        }

        yield* save(status === "done" ? "done" : "running");
        yield* execution.flush();

        return true;
      });

    const begin = Effect.gen(function* beginSession() {
      if (checkpoint === null) {
        countStarts(execution.started);
        run.state = { ...run.state, transitions: run.state.transitions + 1 };

        if (overCap([])) {
          yield* save("envelope-exceeded");

          return false;
        }

        yield* save("running");
        yield* execution.flush();

        return true;
      }

      const { children } = execution.view();

      for (const event of checkpoint.mailbox) {
        const child =
          event.actorId === undefined ? undefined : children[event.actorId];

        mailbox.push(
          child === undefined ? event : { ...event, sessionId: child.sessionId }
        );
      }

      yield* execution.flush();

      return true;
    });

    const loop = Effect.gen(function* driveLoop() {
      while (execution.view().status === "active") {
        if (yield* store.readPaused(runId)) {
          return yield* mark("paused");
        }

        if (run.state.transitions >= run.plan.envelope.maxSteps) {
          return yield* mark("envelope-exceeded");
        }

        const point = amendHere();

        if (point !== undefined) {
          if (!(yield* elaborated(point))) {
            return yield* mark("amendment-refused");
          }

          continue;
        }

        if (
          factsHere().some((fact) => fact.kind === "migrate") &&
          !mailbox.some(({ type }) => type === AMENDED)
        ) {
          mailbox.push({ type: AMENDED });
        }

        const choice = yield* choose;

        if (choice.kind === "halt") {
          return yield* mark(choice.status);
        }

        if (!(yield* advance(choice.event))) {
          return yield* report;
        }
      }

      return yield* report;
    });

    return (yield* begin) ? yield* loop : yield* report;
  });
