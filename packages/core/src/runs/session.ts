import {
  Clock,
  Crypto,
  Deferred,
  Effect,
  Option,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { constVoid } from "effect/Function";
import { createAsyncLogic } from "xstate";
import type { AnyEventObject, Snapshot } from "xstate";

import { amendPlan } from "../plans/amend.js";
import type { AmendPoint } from "../plans/amend.js";
import {
  AMENDED,
  compilePlan,
  planFacts,
  replyEvent,
} from "../plans/compile.js";
import type { Ask } from "../plans/compile.js";
import { docRefs, docText, interpolate } from "../plans/doc-refs.js";
import { decodeAmendment } from "../plans/schema.js";
import type { Plan } from "../plans/schema.js";
import { checkPlan, refuseCode } from "../plans/validate.js";
import {
  AskInputSchema,
  ElaborateInputSchema,
  JudgeInputSchema,
  OutputEventSchema,
  SwitchInputSchema,
  ThinkInputSchema,
} from "../steps/inputs.js";
import type {
  AskInput,
  ElaborateInput,
  JudgeInput,
  SwitchInput,
  JudgeVerdict,
  QuestionInput,
  ThinkInput,
} from "../steps/inputs.js";
import {
  Judge,
  askedDocName,
  reasonDocName,
  whyDocName,
} from "../steps/judge.js";
import { Mail, SealedSchema } from "../steps/mail.js";
import { Operator } from "../steps/operator.js";
import { ProviderUnavailable } from "../steps/provider-unavailable.js";
import { thinkLine, thinkTotals } from "../steps/receipt.js";
import type { ThinkReceipt } from "../steps/receipt.js";
import { StepFailed } from "../steps/step-failed.js";
import { unmappedReason } from "../steps/think-model-unmapped.js";
import { Thinker } from "../steps/thinker.js";
import { VerdictDeferred } from "../steps/verdict-deferred.js";
import { describeValue, leaves, openExecution } from "./execution.js";
import type { Adapter, Execution, Sources } from "./execution.js";
import { fingerprintOf, stepOf } from "./fingerprint.js";
import { docWrites, docsRead } from "./replay.js";
import { RunStore } from "./run-store.js";
import { DirectiveKey, directiveKey, DirectiveSchema } from "./schema.js";
import type {
  Awaiting,
  Held,
  Directive,
  Docs,
  PendingDirective,
  QueuedEvent,
  RunReport,
  RunState,
  RunStatus,
} from "./schema.js";

export type StepServices =
  | Crypto.Crypto
  | Judge
  | Mail
  | Operator
  | RunStore
  | Thinker;

export interface RevisionWatch {
  readonly dryRun: boolean;
  readonly live: string[];
  readonly reused: string[];
}

export interface Delivery {
  readonly kind: "answer";
  readonly reply: string;
}

type Choice =
  | { readonly kind: "event"; readonly event: QueuedEvent }
  | { readonly kind: "halt"; readonly status: RunStatus };

const DRAINED = { type: "mischief.drained" };

const isText = Schema.is(Schema.String);

const statusAfter = (machine: string): RunStatus => {
  switch (machine) {
    case "done": {
      return "done";
    }

    case "error": {
      return "failed";
    }

    default: {
      return "running";
    }
  }
};

const decodeFailure = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.String,
    reason: Schema.optionalKey(Schema.String),
  })
);

const reasonOf = (failure: {
  readonly error: string;
  readonly reason?: string;
}) => failure.reason ?? failure.error;

const isStepFailed = Schema.is(StepFailed);

const decodeVerdict = Schema.decodeUnknownOption(OutputEventSchema);

const decodeSent = Schema.decodeUnknownOption(
  Schema.Struct({ messageId: Schema.String })
);

const decodeOutput = Schema.decodeUnknownEffect(Schema.Json);

const decodeIdentity = Schema.decodeUnknownOption(
  Schema.Struct({ machine: Schema.Struct({ id: Schema.String }) })
);

const failed = (key: string, reason: string) => new StepFailed({ key, reason });

const shown = (ask: Ask | undefined, docs: Docs) => {
  if (ask === undefined) {
    return null;
  }

  const asked = docs[askedDocName(ask.key)];
  const reason = docs[reasonDocName(ask.key)];

  const question = {
    ...ask,
    question: isText(asked) ? asked : interpolate(ask.question, docs).text,
  };

  return isText(reason) ? { ...question, reason } : question;
};

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

    const journal = [...(yield* store.readJournal(runId))];

    const thought = thinkTotals(journal.map(([, entry]) => entry));

    const failures = journal.flatMap(([key, entry]) =>
      Option.match(decodeFailure(entry), {
        onNone: () => [],
        onSome: (failure) => [{ key, reason: reasonOf(failure) }],
      })
    );

    const bare: RunReport = {
      docs: yield* store.readDocs(runId),
      planId: plan.id,
      planVersion: state.planVersion,
      runId,
      status: state.status,
      transitions: state.transitions,
      value: state.value,
    };

    const base: RunReport =
      thought === undefined
        ? bare
        : { ...bare, thinking: { ...thought, line: thinkLine(thought) } };

    const withFailures: RunReport =
      failures.length > 0 ? { ...base, failures } : base;

    const report: RunReport =
      state.status === "waiting-for-provider" && state.held.length > 0
        ? { ...withFailures, held: state.held }
        : withFailures;

    if (state.awaiting.length > 0 && state.status !== "waiting-for-joel") {
      return { ...report, awaiting: state.awaiting } satisfies RunReport;
    }

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
  delivery: Delivery | undefined,
  watch?: RevisionWatch
) =>
  Effect.gen(function* runSession() {
    const store = yield* RunStore;
    const thinker = yield* Thinker;
    const judge = yield* Judge;
    const mail = yield* Mail;
    const operator = yield* Operator;
    const crypto = yield* Crypto.Crypto;

    const saving = yield* Semaphore.make(1);

    const runPromise = Effect.runPromiseWith(
      yield* Effect.context<StepServices>()
    );

    const journal = new Map(yield* store.readJournal(runId));
    const prints = new Map(yield* store.readFingerprints(runId));
    const mailbox: QueuedEvent[] = [];
    const pending = new Map<symbol, Promise<Schema.Json>>();

    const wakers = new Set<Deferred.Deferred<boolean>>();

    const parked = new Map<string, Awaiting>();
    const holds = new Map<string, Held>();
    const visits = new Map<string, number>();

    const starts = new Map(
      Object.entries(opened.state.checkpoint?.starts ?? {})
    );

    const answers = new Map(Object.entries(opened.state.answers));

    const run = {
      facts: planFacts(opened.plan),
      plan: opened.plan,
      reply: delivery?.reply,
      state: opened.state,
    };

    const strictFor = (key: string) =>
      run.state.revision !== null &&
      (key.startsWith("logic:") || key.startsWith("seal:"));

    const diverge = (key: string) => {
      const { revision } = run.state;

      if (revision !== null && !revision.diverged && key.startsWith("logic:")) {
        run.state = { ...run.state, revision: { ...revision, diverged: true } };
      }
    };

    const journaled = (
      key: string,
      exec: Effect.Effect<Schema.Json, StepFailed>,
      fingerprint: Effect.Effect<string> = Effect.succeed(""),
      reuse: (entry: Schema.Json) => Effect.Effect<void> = () => Effect.void
    ) =>
      Effect.gen(function* replayOrRun() {
        const hit = journal.get(key);
        const strict = strictFor(key);

        if (hit !== undefined && !strict) {
          const failure = decodeFailure(hit);

          return Option.isSome(failure)
            ? yield* failed(key, failure.value.error)
            : hit;
        }

        const print = yield* fingerprint;

        if (
          hit !== undefined &&
          print !== "" &&
          prints.get(key) === print &&
          Option.isNone(decodeFailure(hit))
        ) {
          if (key.startsWith("logic:")) {
            watch?.reused.push(key);
          }

          yield* reuse(hit);

          return hit;
        }

        if (strict && key.startsWith("logic:")) {
          watch?.live.push(key);

          if (watch?.dryRun === true) {
            return yield* failed(key, "a dry run stops where live work starts");
          }
        }

        diverge(key);

        if (print !== "") {
          prints.set(key, print);
          yield* store.writeFingerprint(runId, key, print);
        }

        const outcome = yield* Effect.result(exec);

        const entry = Result.isSuccess(outcome)
          ? outcome.success
          : { error: `${key} failed`, reason: outcome.failure.reason };

        journal.set(key, entry);
        yield* store.writeJournal(runId, key, entry);

        return Result.isSuccess(outcome)
          ? outcome.success
          : yield* outcome.failure;
      });

    const printOf = (step: Schema.Json) =>
      store.readDocs(runId).pipe(
        Effect.flatMap((docs) =>
          fingerprintOf(crypto, {
            docs: Object.fromEntries(
              docsRead(step).map((name) => [name, docs[name] ?? null])
            ),
            step,
          })
        )
      );

    const recordJournal = (key: string, value: Schema.Json) =>
      Effect.suspend(() => {
        journal.set(key, value);

        return store.writeJournal(runId, key, value);
      });

    const recordInput = (key: string, value: string) =>
      recordJournal(key, value);

    const PRODUCED = "directive:";

    const produce = (key: string, directive: Directive) =>
      Effect.suspend(() =>
        journal.has(`${PRODUCED}${key}`)
          ? Effect.void
          : recordJournal(`${PRODUCED}${key}`, directive)
      );

    const deliveryKey = (stepKey: string, cause: string) =>
      Effect.suspend(() => {
        const known = Schema.decodeUnknownOption(DirectiveKey)(
          journal.get(cause)
        );

        if (Option.isSome(known)) {
          return Effect.succeed(known.value);
        }

        const key = directiveKey({
          index: 0,
          runId,
          step: stepKey,
          visit:
            [...journal.keys()].filter((entry) =>
              entry.startsWith(`${PRODUCED}${runId}:${stepKey}:`)
            ).length + 1,
        });

        return recordJournal(cause, key).pipe(Effect.as(key));
      });

    const pendingNow = Effect.suspend(() =>
      Effect.forEach(
        [...journal.keys()].flatMap((entry) =>
          entry.startsWith(PRODUCED) &&
          !journal.has(`done:${entry.slice(PRODUCED.length)}`)
            ? [entry.slice(PRODUCED.length)]
            : []
        ),
        (key) =>
          Schema.decodeUnknownEffect(DirectiveSchema)(
            journal.get(`${PRODUCED}${key}`)
          ).pipe(
            Effect.map((directive): PendingDirective => ({ directive, key })),
            Effect.orDie
          )
      )
    );

    const visitOf = (key: string) => visits.get(key) ?? 1;

    const epochOf = () => (run.state.revision === null ? 0 : run.plan.version);

    const step = <A, E>(key: string, effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.tapError((failure) =>
          isStepFailed(failure)
            ? store.writeDoc(runId, `failed:${key}`, true)
            : Effect.void
        )
      );

    const writeDoc = (name: string | undefined, doc: Schema.Json) =>
      name === undefined ? Effect.void : store.writeDoc(runId, name, doc);

    const withDocs = (key: string, text: string) =>
      docRefs(text).length === 0
        ? Effect.succeed(text)
        : store.readDocs(runId).pipe(
            Effect.flatMap((docs) => {
              const filled = interpolate(text, docs);

              return filled.missing.length === 0
                ? Effect.succeed(filled.text)
                : Effect.fail(
                    new StepFailed({
                      key,
                      reason: `it reads ${filled.missing.map((name) => `{{docs.${name}}}`).join(", ")}, which no step has written on this run's path yet. Make the writing step run before this one, or seed the doc at submit`,
                    })
                  );
            })
          );

    const observed = (key: string, receipt: ThinkReceipt | undefined) =>
      receipt === undefined
        ? Effect.void
        : (operator.thought?.(runId, key, receipt) ?? Effect.void).pipe(
            Effect.ignoreCause
          );

    const think = (input: ThinkInput) =>
      Effect.gen(function* thinkStep() {
        const thought = yield* step(
          input.key,
          withDocs(input.key, input.prompt).pipe(
            Effect.flatMap((prompt) =>
              thinker.think({
                agent: input.agent ?? {},
                epoch: epochOf(),
                key: input.key,
                prompt,
                runId,
                visit: visitOf(input.key),
              })
            ),
            Effect.tap(({ receipt }) => observed(input.key, receipt))
          )
        );

        yield* writeDoc(input.writes, thought.output);

        const base = {
          cacheRead: thought.cacheRead ?? 0,
          output: thought.output,
          tokens: thought.tokens,
        };

        return thought.receipt === undefined
          ? base
          : { ...base, receipt: thought.receipt };
      });

    const ask = (input: AskInput) =>
      Effect.gen(function* askStep() {
        const call = {
          epoch: epochOf(),
          key: input.key,
          runId,
          visit: visitOf(input.key),
        };

        const sealed = yield* journaled(
          `seal:${input.key}#${call.visit}`,
          step(
            input.key,
            withDocs(input.key, input.message).pipe(
              Effect.flatMap((message) =>
                mail.seal({ ...call, message, to: input.to })
              )
            )
          ),
          printOf({ input, src: "ask" })
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(SealedSchema)),
          Effect.mapError(() => failed(input.key, "sealed envelope refused"))
        );

        yield* store.writeMessage(sealed.messageId, runId);
        yield* store.writeDoc(runId, `__sent:${input.key}`, {
          messageId: sealed.messageId,
          to: input.to,
        });
        const key = yield* deliveryKey(input.key, `asked:${sealed.messageId}`);

        yield* produce(
          key,
          DirectiveSchema.cases.Ask.make({
            envelope: sealed.envelope,
            epoch: call.epoch,
            messageId: sealed.messageId,
            to: input.to,
            visit: call.visit,
          })
        );

        if (!journal.has(`done:${key}`)) {
          // oxlint-disable-next-line eslint/no-use-before-define -- an ask checkpoints its own directive before delivering it; save is defined with the drive loop.
          yield* save("running");

          const sent = yield* Effect.result(mail.send(call, sealed));

          yield* recordJournal(
            `done:${key}`,
            Result.isSuccess(sent)
              ? true
              : { error: `${key} failed`, reason: sent.failure.reason }
          );

          if (Result.isFailure(sent)) {
            return yield* step(input.key, Effect.fail(sent.failure));
          }
        }

        return { messageId: sealed.messageId, tokens: 0 };
      });

    const branchOn = (input: SwitchInput) =>
      Effect.gen(function* switchStep() {
        const docs = yield* store.readDocs(runId);
        const value = docs[input.reads];

        if (value === undefined) {
          return yield* step(
            input.key,
            Effect.fail(
              failed(
                input.key,
                `it switches on doc "${input.reads}", which no step has written on this run's path yet. Make the writing step run before this switch, or seed the doc at submit`
              )
            )
          );
        }

        const text = docText(value).trim();
        const matched = Object.hasOwn(input.cases, text);

        return {
          choice: matched
            ? (input.cases[text] ?? input.default)
            : input.default,
          defaulted: !matched,
          tokens: 0,
          value: text.slice(0, 200),
        };
      });

    const elaborate = (input: ElaborateInput) =>
      Effect.gen(function* elaborateStep() {
        const result = yield* step(
          input.key,
          thinker.elaborate({
            epoch: epochOf(),
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
        const stored = yield* store.readDocs(runId);

        const asked = interpolate(input.question, stored).text;

        const call = {
          agent: input.thinkAgent ?? {},
          epoch: epochOf(),
          key: input.key,
          options: input.options,
          question: asked,
          runId,
          visit: visitOf(input.key),
        };

        const reply = Option.fromNullishOr(
          run.state.replies.find(({ key }) => key === input.key)
        );

        const docs = Object.fromEntries(
          (input.reads ?? []).flatMap((name) =>
            name in stored ? [[name, stored[name] ?? null]] : []
          )
        );

        const { probabilities, usage, why } = yield* step(
          input.key,
          judge.choose({
            ...call,
            criteria: input.criteria,
            docs,
            reply: reply.pipe(Option.map(({ body }) => body)),
          })
        );

        const [top] = Object.entries(probabilities).toSorted(
          (left, right) => right[1] - left[1]
        );

        const jev = { probs: probabilities, rung: "jev", usage: { ...usage } };

        if (why !== undefined) {
          yield* writeDoc(whyDocName(input.key), [...why]);
        }

        const withWhy = <A extends object>(verdict: A) =>
          why === undefined ? verdict : { ...verdict, why: [...why] };

        const escalated = (
          ladder: readonly Schema.Json[],
          tokens: number,
          reason?: string
        ) =>
          writeDoc(askedDocName(input.key), asked).pipe(
            Effect.andThen(
              reason === undefined
                ? Effect.void
                : writeDoc(reasonDocName(input.key), reason)
            ),
            Effect.as(
              withWhy(
                reason === undefined
                  ? { asked, escalate: true, ladder, tokens }
                  : { asked, escalate: true, ladder, reason, tokens }
              )
            )
          );

        if (top !== undefined && top[1] >= (input.threshold ?? 1)) {
          return withWhy({
            choice: top[0],
            ladder: [jev],
            tokens: usage.tokens,
          });
        }

        const { fallback, thinkThreshold } = input;

        if (fallback !== undefined) {
          return withWhy({
            choice: fallback,
            ladder: [jev, { rung: "fallback" }],
            tokens: usage.tokens,
          });
        }

        if (thinkThreshold === undefined) {
          return yield* escalated([jev], usage.tokens);
        }

        const deliberated = yield* step(
          input.key,
          thinker.decide(call).pipe(
            Effect.tap((done) => observed(input.key, done.usage.receipt)),
            Effect.map((done) => Result.succeed(done)),
            Effect.catchTag("ThinkModelUnmapped", (unmapped) =>
              Effect.succeed(Result.fail(unmapped))
            )
          )
        );

        if (Result.isFailure(deliberated)) {
          return yield* escalated(
            [jev, { rung: "think", unmapped: deliberated.failure.model }],
            usage.tokens,
            unmappedReason(deliberated.failure)
          );
        }

        const deliberation = deliberated.success;

        const tokens = usage.tokens + deliberation.usage.tokens;

        const rung = Option.match(deliberation.decision, {
          onNone: () => ({ rung: "think", usage: { ...deliberation.usage } }),
          onSome: ({ choice, confidence }) => ({
            choice,
            confidence,
            rung: "think",
            usage: { ...deliberation.usage },
          }),
        });

        const confident = deliberation.decision.pipe(
          Option.filter(
            ({ choice, confidence }) =>
              confidence >= thinkThreshold && input.options.includes(choice)
          )
        );

        if (Option.isNone(confident)) {
          return yield* escalated([jev, rung], tokens);
        }

        return withWhy({
          choice: confident.value.choice,
          ladder: [jev, rung],
          tokens,
        });
      });

    const logic = <I>(
      schema: Schema.Decoder<I>,
      body: (
        input: I
      ) => Effect.Effect<
        Schema.Json,
        StepFailed | VerdictDeferred | ProviderUnavailable
      >
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
        switch: logic(SwitchInputSchema, branchOn),
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

    const consumeReply = (stepKey: string) =>
      Effect.sync(() => {
        run.state = {
          ...run.state,
          replies: run.state.replies.filter(({ key }) => key !== stepKey),
        };
      });

    // oxlint-disable-next-line typescript/promise-function-async -- runLogic must hand xstate the tracked Promise.
    const track = (
      key: string,
      build: (
        release: Effect.Effect<void>
      ) => Effect.Effect<Schema.Json, StepFailed>
    ) => {
      const token = Symbol(key);
      const settled = { done: false };

      const release = Effect.suspend(() => {
        settled.done = true;
        pending.delete(token);

        return Effect.forEach(wakers, (wake) => Deferred.succeed(wake, true), {
          discard: true,
        });
      });

      const promise = runPromise(
        build(release).pipe(
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

        const stepKey = stepKeyOf(actor.address);

        const work = Effect.tryPromise({
          catch: (cause) =>
            cause instanceof VerdictDeferred ||
            cause instanceof ProviderUnavailable
              ? cause
              : failed(
                  key,
                  isStepFailed(cause) ? cause.reason : `${key} failed`
                ),
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

        const park =
          (release: Effect.Effect<void>) => (deferred: VerdictDeferred) =>
            Effect.gen(function* parkStep() {
              const messageId = `${runId}/${stepKey}#${visit}`;

              yield* store.writeMessage(messageId, runId);
              parked.set(stepKey, {
                key: stepKey,
                messageId,
                to: deferred.to,
                writes: null,
              });
              yield* release;

              return yield* Effect.never;
            });

        const hold =
          (release: Effect.Effect<void>) => (outage: ProviderUnavailable) =>
            Effect.gen(function* holdStep() {
              const held: Held = {
                cause: outage.cause,
                key: stepKey,
                provider: outage.provider,
                since: yield* Clock.currentTimeMillis,
                status: outage.status,
              };

              const notice = `held:${stepKey}#${visit}`;

              holds.set(stepKey, held);
              yield* release;

              if (!journal.has(`done:${notice}`)) {
                const sent = yield* Effect.result(
                  operator.held?.(runId, held, notice) ?? Effect.void
                );

                yield* recordJournal(
                  `done:${notice}`,
                  Result.isSuccess(sent)
                    ? true
                    : { error: `${notice} not announced` }
                );
              }

              return yield* Effect.never;
            });

        return track(key, (release) =>
          journaled(
            key,
            work.pipe(
              Effect.catchTag("VerdictDeferred", park(release)),
              Effect.catchTag("ProviderUnavailable", hold(release))
            ),
            printOf(stepOf(actor)),
            (entry) =>
              Effect.forEach(
                docWrites(stepOf(actor), entry),
                ([name, doc]) => store.writeDoc(runId, name, doc),
                { discard: true }
              )
          ).pipe(Effect.ensuring(consumeReply(stepKey)))
        );
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
          Option.map(({ snapshot }) =>
            migrateTo(
              // SAFETY: the checkpoint snapshot was written by getPersistedSnapshot for this run's plan.
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              snapshot as Snapshot<unknown>,
              run.plan
            )
          )
        ),
        transitionIndex: checkpoint?.transitionIndex ?? 0,
      }
    );

    const factsHere = () =>
      leaves(execution.view().value).flatMap((path) => {
        const fact = run.facts.get(path.join("."));

        return fact === undefined ? [] : [fact];
      });

    const loggedReply = (sent: readonly Awaiting[]) =>
      sent.flatMap(({ key, messageId }) => {
        const body = journal.get(`reply:${messageId}`);

        return isText(body) ? [{ body, key }] : [];
      })[0];

    const loggedAnswer = (question: Ask) => {
      const answer = journal.get(
        `answer:${question.key}#${(answers.get(question.key) ?? 0) + 1}`
      );

      return run.state.revision?.diverged === false && isText(answer)
        ? answer
        : undefined;
    };

    const awaitsHere = () =>
      factsHere().flatMap((fact) => (fact.kind === "await" ? [fact] : []));

    const awaitingOf = (
      docs: Readonly<Record<string, Schema.Json>>
    ): Awaiting[] =>
      awaitsHere().flatMap((fact) =>
        Option.toArray(decodeSent(docs[`__sent:${fact.key}`])).map(
          ({ messageId }) => ({
            key: fact.key,
            messageId,
            to: fact.to,
            writes: fact.writes,
          })
        )
      );

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

    const overBy = (cost: number) =>
      run.state.transitions + cost > run.plan.envelope.maxSteps;

    const cappedFanout = (before: readonly (readonly string[])[]) => {
      const entered = leaves(execution.view().value)
        .map((path) => fanoutOf(path))
        .find((fanout) => fanout !== undefined);

      return entered === undefined ||
        before.some((path) => fanoutOf(path)?.key === entered.key) ||
        !overBy(entered.cost)
        ? undefined
        : entered.key;
    };

    const announceEnvelope = Effect.suspend(() => {
      const { maxSteps } = run.plan.envelope;

      return journal.has(`announce:__envelope#${maxSteps}`)
        ? Effect.void
        : produce(
            directiveKey({
              index: 0,
              runId,
              step: "__envelope",
              visit: maxSteps,
            }),
            DirectiveSchema.cases.Emit.make({
              question: {
                key: "__envelope",
                options: ["extendRun", "abortRun"],
                question: `used ${run.state.transitions} of its ${maxSteps} steps and paused. Raise the limit with extendRun({ runId: "${runId}", maxSteps }) or stop it with abortRun({ runId: "${runId}" })`,
              },
            })
          );
    });

    const report = Effect.suspend(() => reportOf(runId, run.plan, run.state));

    const save = (status: RunStatus) =>
      saving.withPermits(1)(
        Effect.gen(function* saveRun() {
          const docs = yield* store.readDocs(runId);

          run.state = {
            ...run.state,
            answers: Object.fromEntries(answers),
            asking: shown(askHere(), docs),
            awaiting: awaitingOf(docs),
            checkpoint: {
              mailbox: structuredClone(mailbox),
              pending: yield* pendingNow,
              snapshot: execution.persist(),
              starts: Object.fromEntries(starts),
              transitionIndex: execution.nextTransitionIndex(),
            },
            held: [...holds.values()],
            status,
            value: describeValue(execution.view().value),
          };

          yield* store.writeRun(runId, run.state);
        })
      );

    const announce = (key: string, question: QuestionInput) =>
      Effect.gen(function* announceNotice() {
        const sent = yield* Effect.result(
          operator.notify(runId, question, key)
        );

        yield* recordJournal(
          `done:${key}`,
          Result.isSuccess(sent) ? true : { error: `${key} not announced` }
        );
      });

    const deliverPending = Effect.gen(function* deliverStored() {
      if (watch?.dryRun === true) {
        return;
      }

      for (const { directive, key } of run.state.checkpoint?.pending ?? []) {
        if (
          DirectiveSchema.guards.Emit(directive) &&
          !journal.has(`done:${key}`)
        ) {
          yield* announce(key, directive.question);
        }
      }
    });

    const mark = (status: RunStatus) =>
      Effect.gen(function* markRun() {
        yield* saving.withPermits(1)(
          Effect.gen(function* storeStatus() {
            const { checkpoint: stored } = run.state;
            const docs = yield* store.readDocs(runId);

            run.state = {
              ...run.state,
              awaiting: [...awaitingOf(docs), ...parked.values()],
              checkpoint:
                stored === null
                  ? null
                  : { ...stored, pending: yield* pendingNow },
              held: [...holds.values()],
              status,
            };

            yield* store.writeRun(runId, run.state);
          })
        );

        yield* deliverPending;

        return yield* report;
      });

    const saved = (status: RunStatus) =>
      save(status).pipe(Effect.andThen(deliverPending));

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

        const wake = yield* Deferred.make<boolean>();

        wakers.add(wake);

        if (pending.size === 0) {
          wakers.delete(wake);

          return Option.none<QueuedEvent>();
        }

        const inFlight = [...pending.values()];

        yield* Effect.raceFirst(
          // oxlint-disable-next-line typescript/promise-function-async -- Effect.promise consumes a Promise factory directly.
          Effect.promise(() => Promise.allSettled(inFlight)).pipe(
            Effect.asVoid
          ),
          Deferred.await(wake).pipe(Effect.asVoid)
        );

        wakers.delete(wake);
      }
    });

    const choose = Effect.gen(function* chooseEvent() {
      const next = yield* nextEvent;

      if (Option.isSome(next)) {
        return { event: next.value, kind: "event" } satisfies Choice;
      }

      const awaiting = awaitsHere();

      const sentNow = awaitingOf(yield* store.readDocs(runId));

      const replied =
        run.state.replies.find(({ key }) =>
          awaiting.some((fact) => fact.key === key)
        ) ?? loggedReply(sentNow);

      const fact = awaiting.find(({ key }) => key === replied?.key);

      if (replied !== undefined && fact !== undefined) {
        const sent = sentNow.find(({ key }) => key === replied.key);

        yield* recordInput(
          `reply:${sent?.messageId ?? replied.key}`,
          replied.body
        );

        if (fact.writes !== null) {
          yield* store.writeDoc(runId, fact.writes, replied.body);
        }

        run.state = {
          ...run.state,
          replies: run.state.replies.filter(({ key }) => key !== replied.key),
        };

        return {
          event: { type: replyEvent(replied.key) },
          kind: "event",
        } satisfies Choice;
      }

      if (holds.size > 0) {
        return {
          kind: "halt",
          status: "waiting-for-provider",
        } satisfies Choice;
      }

      if (awaiting.length > 0 || parked.size > 0) {
        return { kind: "halt", status: "waiting-for-reply" } satisfies Choice;
      }

      const question = askHere();

      if (question === undefined) {
        return { kind: "halt", status: "stuck" } satisfies Choice;
      }

      const chosen = run.reply ?? loggedAnswer(question);

      run.reply = undefined;

      if (chosen === undefined || !question.options.includes(chosen)) {
        const asked = (answers.get(question.key) ?? 0) + 1;

        const notice = `announce:${question.key}#${asked}${run.state.revision === null ? "" : `@v${run.plan.version}`}`;

        if (!journal.has(notice)) {
          const docs = yield* store.readDocs(runId);

          yield* produce(
            yield* deliveryKey(question.key, notice),
            DirectiveSchema.cases.Emit.make({
              question: shown(question, docs) ?? question,
            })
          );
        }

        return { kind: "halt", status: "waiting-for-joel" } satisfies Choice;
      }

      const answered = (answers.get(question.key) ?? 0) + 1;

      yield* recordInput(`answer:${question.key}#${answered}`, chosen);
      answers.set(question.key, answered);

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
          amendPlan(run.plan, point, amendment.value),
          Object.keys(yield* store.readDocs(runId))
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

        yield* saved("running");

        yield* execution.flush();

        return true;
      });

    const advance = (event: QueuedEvent) =>
      Effect.gen(function* advanceRun() {
        const before = leaves(execution.view().value);

        countStarts(execution.send(event));
        run.state = { ...run.state, transitions: run.state.transitions + 1 };

        const { status } = execution.view();
        const capped = status === "active" ? cappedFanout(before) : undefined;

        if (
          status === "active" &&
          (run.state.transitions >= run.plan.envelope.maxSteps ||
            capped !== undefined)
        ) {
          run.state = { ...run.state, capped: capped ?? null };
          yield* announceEnvelope;
          yield* saved("envelope-exceeded");

          return false;
        }

        yield* saved(statusAfter(status));

        yield* execution.flush();

        return true;
      });

    const begin = Effect.gen(function* beginSession() {
      if (checkpoint === null && run.state.revision !== null) {
        const docs = yield* store.readDocs(runId);
        const seeded = new Set(run.state.seeded);

        yield* store.replaceDocs(
          runId,
          Object.fromEntries(
            Object.entries(docs).filter(([name]) => seeded.has(name))
          )
        );
      }

      if (checkpoint === null) {
        countStarts(execution.started);
        run.state = { ...run.state, transitions: run.state.transitions + 1 };

        const capped = cappedFanout([]);

        if (capped !== undefined) {
          run.state = { ...run.state, capped };
          yield* announceEnvelope;
          yield* saved("envelope-exceeded");

          return false;
        }

        yield* saved(statusAfter(execution.view().status));

        yield* execution.flush();

        return true;
      }

      const { capped } = run.state;
      const fact = capped === null ? undefined : run.facts.get(capped);

      if (
        run.state.transitions >= run.plan.envelope.maxSteps ||
        (fact?.kind === "fanout" && overBy(fact.cost))
      ) {
        yield* announceEnvelope;
        yield* mark("envelope-exceeded");

        return false;
      }

      run.state = { ...run.state, capped: null };

      const { children } = execution.view();

      for (const event of checkpoint.mailbox) {
        const child =
          event.actorId === undefined ? undefined : children[event.actorId];

        mailbox.push(
          child === undefined ? event : { ...event, sessionId: child.sessionId }
        );
      }

      yield* deliverPending;
      yield* execution.flush();

      return true;
    });

    const loop = Effect.gen(function* driveLoop() {
      while (execution.view().status === "active") {
        if (yield* store.readPaused(runId)) {
          return yield* mark("paused");
        }

        if (run.state.transitions >= run.plan.envelope.maxSteps) {
          yield* announceEnvelope;

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
