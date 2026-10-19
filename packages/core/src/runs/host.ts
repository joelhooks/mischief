import {
  Clock,
  Context,
  Crypto,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";

import { DeclaredThinking } from "../plans/declared-thinking.js";
import { EnabledStepKinds } from "../plans/step-kinds.js";
import { PlanRefused, validatePlan } from "../plans/validate.js";
import { CallRegistry } from "../steps/call-registry.js";
import { Judge } from "../steps/judge.js";
import { Operator } from "../steps/operator.js";
import { AnswerRefused } from "./answer-refused.js";
import { closeOpenAsks } from "./close-asks.js";
import { Drive } from "./drive.js";
import { ExtendRefused } from "./extend-refused.js";
import { canonical, fingerprintOf } from "./fingerprint.js";
import { overloadHeld, ProviderResume } from "./provider-resume.js";
import { ReplyRefused } from "./reply-refused.js";
import { RevisionRefused } from "./revision-refused.js";
import { RunStore, withinRun } from "./run-store.js";
import { terminalStatuses } from "./schema.js";
import type {
  Docs,
  ReplyLine,
  RevisionReport,
  RunRecord,
  RunReport,
  RunState,
} from "./schema.js";
import { driveSession, reportOf } from "./session.js";
import type { RevisionWatch, StepServices } from "./session.js";
import { checkSubmission } from "./submission.js";
import { UnknownRun } from "./unknown-run.js";

const decodeJsonObject = Schema.decodeUnknownOption(Schema.JsonObject);

export class RunHost extends Context.Service<
  RunHost,
  {
    readonly submit: (
      runId: string,
      plan: Schema.Json,
      docs?: Docs
    ) => Effect.Effect<RunReport, PlanRefused>;
    readonly advance: (runId: string) => Effect.Effect<RunReport, UnknownRun>;
    readonly answer: (
      runId: string,
      reply: string
    ) => Effect.Effect<RunReport, UnknownRun | AnswerRefused>;
    readonly deliver: (
      line: ReplyLine
    ) => Effect.Effect<RunReport, ReplyRefused>;
    readonly extend: (
      runId: string,
      maxSteps: number
    ) => Effect.Effect<RunReport, UnknownRun | ExtendRefused>;
    readonly revise: (
      runId: string,
      plan: Schema.Json,
      dryRun: boolean
    ) => Effect.Effect<RevisionReport, UnknownRun | RevisionRefused>;
    readonly inspect: (runId: string) => Effect.Effect<RunReport, UnknownRun>;
    readonly read: (runId: string) => Effect.Effect<RunRecord, UnknownRun>;
    readonly pause: (runId: string) => Effect.Effect<RunReport, UnknownRun>;
    readonly resume: (runId: string) => Effect.Effect<RunReport, UnknownRun>;
    readonly abort: (
      runId: string,
      supersededBy?: string
    ) => Effect.Effect<RunReport, UnknownRun>;
  }
>()("@mischief/core/RunHost", {
  make: Effect.gen(function* makeRunHost() {
    const context = yield* Effect.context<StepServices>();
    const store = yield* RunStore;
    const operator = yield* Operator;
    const judge = yield* Judge;
    const enabledKinds = yield* EnabledStepKinds;
    const registry = yield* CallRegistry;
    const declared = yield* DeclaredThinking;
    const resumePolicy = yield* ProviderResume;
    const driver = yield* Drive;

    const hostGates = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(EnabledStepKinds, enabledKinds),
        Effect.provideService(CallRegistry, registry),
        Effect.provideService(DeclaredThinking, declared)
      );

    const loadRun = Effect.fn("RunHost.loadRun")(function* loadRun(
      runId: string
    ) {
      const state = yield* store.readRun(runId);

      if (Option.isNone(state)) {
        return yield* new UnknownRun({ runId });
      }

      const plan = yield* store.readPlan(runId, state.value.planVersion);

      if (Option.isNone(plan)) {
        return yield* new UnknownRun({ runId });
      }

      return { plan: plan.value, state: state.value };
    });

    const announceHoldAlarm = (
      runId: string,
      report: RunReport,
      attempts: number
    ) =>
      Effect.gen(function* alarmHeldRun() {
        if (
          report.status !== "waiting-for-provider" ||
          attempts < resumePolicy.attempts ||
          report.held?.some(overloadHeld) !== true
        ) {
          return;
        }

        const notice = "hold-alarm";
        const journal = yield* store.readJournal(runId);

        if (!journal.has(`done:${notice}`)) {
          const sent = yield* Effect.result(
            operator.holdAlarm?.(runId, report.held, attempts, notice) ??
              Effect.void
          );

          if (Result.isFailure(sent)) {
            yield* Effect.logWarning(
              `${runId} cap alarm remains pending: ${sent.failure}`
            );

            return;
          }

          yield* store.writeJournal(runId, `done:${notice}`, true);
          yield* store.commit(runId);
        }
      });

    const announceFailure = (runId: string, report: RunReport) =>
      Effect.gen(function* failureNotice() {
        if (report.status !== "failed") {
          return;
        }

        const notice = "failed";
        const journal = yield* store.readJournal(runId);

        if (journal.has(`done:${notice}`)) {
          return;
        }

        const sent = yield* Effect.result(
          operator.failed?.(runId, report.failures ?? [], notice) ?? Effect.void
        );

        yield* store.writeJournal(
          runId,
          `done:${notice}`,
          Result.isSuccess(sent) ? true : { error: `${notice} not announced` }
        );
        yield* store.commit(runId);
      });

    const drive = Effect.fn("RunHost.drive")(function* drive(runId: string) {
      const opened = yield* loadRun(runId);

      if (
        terminalStatuses.has(opened.state.status) ||
        opened.state.status === "waiting-for-provider"
      ) {
        return yield* reportOf(runId, opened.plan, opened.state);
      }

      if (
        opened.state.status === "paused" &&
        (yield* store.readPaused(runId))
      ) {
        return yield* reportOf(runId, opened.plan, opened.state);
      }

      const report = yield* driveSession(runId, opened, undefined, true);

      yield* announceHoldAlarm(runId, report, opened.state.resumeAttempts);
      yield* announceFailure(runId, report);

      return report;
    }, Effect.provideContext(context));

    const inspect = Effect.fn("RunHost.inspect")(function* inspect(
      runId: string
    ) {
      const { plan, state } = yield* loadRun(runId);

      return yield* reportOf(runId, plan, state);
    }, Effect.provideContext(context));

    const read = Effect.fn("RunHost.read")(function* read(runId: string) {
      const { plan, state } = yield* loadRun(runId);
      const journal = yield* store.readJournal(runId);

      return {
        journal: [...journal].map(([key, entry]) => ({ entry, key })),
        plan,
        planVersion: state.planVersion,
        runId,
      } satisfies RunRecord;
    });

    const submit = Effect.fn("RunHost.submit")(function* submit(
      runId: string,
      input: Schema.Json,
      docs: Docs = {}
    ) {
      const submitted = yield* fingerprintOf(
        Context.get(context, Crypto.Crypto),
        { docs, plan: input }
      );

      const existing = yield* store.readRun(runId);

      if (Option.isSome(existing)) {
        if (
          existing.value.submitted !== null &&
          existing.value.submitted !== submitted
        ) {
          return yield* new PlanRefused({
            errors: [
              `run "${runId}" already exists with a different plan or seed docs, so this submit changes nothing. Call inspectRun({ runId: "${runId}" }) to see it, reviseRun({ runId: "${runId}", plan }) to change its plan, or submitPlan under a new runId.`,
            ],
          });
        }

        return yield* inspect(runId).pipe(Effect.orDie);
      }

      const plan = yield* hostGates(checkSubmission(input, docs));
      const refusals = judge.admits?.(plan) ?? [];

      if (refusals.length > 0) {
        return yield* new PlanRefused({ errors: refusals });
      }

      yield* store.writePlan(runId, plan);
      yield* Effect.forEach(
        Object.entries(docs),
        ([name, doc]) => store.writeDoc(runId, name, doc),
        { discard: true }
      );

      const fresh: RunState = {
        answers: {},
        asking: null,
        awaiting: [],
        capped: null,
        checkpoint: null,
        held: [],
        planVersion: plan.version,
        replies: [],
        resumeAttempts: 0,
        revision: null,
        seeded: Object.keys(docs).toSorted(),
        status: "running",
        submitted,
        transitions: 0,
        value: null,
      };

      yield* store.writeRun(runId, fresh);

      return yield* reportOf(runId, plan, fresh).pipe(
        Effect.provideContext(context)
      );
    });

    const answer = Effect.fn("RunHost.answer")(function* answer(
      runId: string,
      reply: string
    ) {
      const report = yield* inspect(runId);

      if (report.question === undefined) {
        return yield* new AnswerRefused({
          reason: `the run is ${report.status} and has no open question. Call inspectRun({ runId: "${runId}" }) to see its state${report.status === "paused" ? `, or resumeRun({ runId: "${runId}" }) to continue it` : ""}.`,
          runId,
        });
      }

      if (!report.question.options.includes(reply)) {
        return yield* new AnswerRefused({
          reason: `"${reply}" is not an option for "${report.question.question}". Call answerRun({ runId: "${runId}", reply }) with reply one of: ${report.question.options.join(", ")}.`,
          runId,
        });
      }

      const { state } = yield* loadRun(runId);
      const { question } = report;

      yield* store.writeJournal(
        runId,
        `answer-pending:${question.key}#${(state.answers[question.key] ?? 0) + 1}@v${state.planVersion}`,
        reply
      );
      yield* store.writeRun(runId, { ...state, status: "running" });

      return yield* inspect(runId);
    });

    const pause = Effect.fn("RunHost.pause")(function* pause(runId: string) {
      const { state } = yield* loadRun(runId);
      yield* store.writePaused(runId, true);

      if (!terminalStatuses.has(state.status)) {
        yield* store.writeRun(runId, { ...state, status: "paused" });
      }

      return yield* inspect(runId);
    });

    const resume = Effect.fn("RunHost.resume")(function* resume(runId: string) {
      const { state } = yield* loadRun(runId);

      yield* store.writePaused(runId, false);

      if (!terminalStatuses.has(state.status)) {
        yield* store.writeRun(runId, { ...state, held: [], status: "running" });
      }

      return yield* inspect(runId);
    });

    const advance = Effect.fn("RunHost.advance")(function* advance(
      runId: string
    ) {
      const opened = yield* loadRun(runId);

      if (opened.state.status !== "waiting-for-provider") {
        return yield* drive(runId);
      }

      const now = yield* Clock.currentTimeMillis;

      const due = opened.state.held.filter(
        (held) =>
          overloadHeld(held) &&
          held.resumeAfter !== null &&
          held.resumeAfter <= now
      );

      if (
        due.length === 0 ||
        opened.state.resumeAttempts >= resumePolicy.attempts ||
        (yield* store.readPaused(runId))
      ) {
        const report = yield* reportOf(runId, opened.plan, opened.state).pipe(
          Effect.provideContext(context)
        );

        if (!(yield* store.readPaused(runId))) {
          yield* announceHoldAlarm(runId, report, opened.state.resumeAttempts);
        }

        return report;
      }

      const admitted = new Set(due.map(({ key }) => key));

      yield* store.writeRun(runId, {
        ...opened.state,
        held: opened.state.held.filter(({ key }) => !admitted.has(key)),
        resumeAttempts: opened.state.resumeAttempts + 1,
        status: "running",
      });
      yield* store.commit(runId);

      return yield* drive(runId);
    });

    const abort = Effect.fn("RunHost.abort")(function* abort(
      runId: string,
      supersededBy?: string
    ) {
      const { plan, state } = yield* loadRun(runId);

      if (terminalStatuses.has(state.status)) {
        return yield* reportOf(runId, plan, state).pipe(
          Effect.provideContext(context)
        );
      }

      yield* closeOpenAsks(runId, state.awaiting, supersededBy).pipe(
        Effect.provideContext(context)
      );

      const aborted: RunState = { ...state, status: "aborted" };
      yield* store.writeRun(runId, aborted);

      return yield* reportOf(runId, plan, aborted).pipe(
        Effect.provideContext(context)
      );
    });

    const deliver = Effect.fn("RunHost.deliver")(function* deliver(
      line: ReplyLine
    ) {
      const refuse = (reason: string) =>
        new ReplyRefused({ reason, replyTo: line.replyTo });

      const owner = yield* store.readMessage(line.replyTo);

      if (Option.isNone(owner)) {
        return yield* refuse(
          "no run sent that message. Check replyTo against the messageId the ask sent; inspectRun shows it under awaiting."
        );
      }

      const runId = owner.value;

      if (line.runId !== undefined && line.runId !== runId) {
        return yield* refuse(
          `${line.replyTo} was sent by run ${runId}, not ${line.runId}. Send it again with runId "${runId}"; nothing changed.`
        );
      }

      const { state } = yield* loadRun(runId).pipe(Effect.orDie);

      const open = state.awaiting.find(
        ({ messageId }) => messageId === line.replyTo
      );

      const openAsks = state.awaiting
        .map(
          ({ key, messageId, to }) => `${key} to ${to} (replyTo ${messageId})`
        )
        .join("; ");

      if (terminalStatuses.has(state.status) || open === undefined) {
        return yield* refuse(
          `run ${runId} is not waiting on it (status ${state.status}). It was already delivered or the run has moved on; nothing changed. Open asks: ${openAsks || "none"}.`
        );
      }

      if (line.from === undefined) {
        return yield* refuse(
          `the sender is unverified. Only a signed reply from ${open.to} can answer it.`
        );
      }

      if (line.from !== open.to) {
        return yield* refuse(
          `the ask went to ${open.to}, but this reply is from ${line.from}. Only ${open.to} can answer it.`
        );
      }

      const resumed = (yield* store.readPaused(runId)) ? "paused" : "running";

      yield* store.writeRun(runId, {
        ...state,
        replies: [...state.replies, { body: line.body, key: open.key }],
        status: state.status === "envelope-exceeded" ? state.status : resumed,
      });

      return yield* inspect(runId).pipe(Effect.orDie);
    });

    const extend = Effect.fn("RunHost.extend")(function* extend(
      runId: string,
      maxSteps: number
    ) {
      const { plan, state } = yield* loadRun(runId);
      const current = plan.envelope.maxSteps;

      if (terminalStatuses.has(state.status)) {
        return yield* new ExtendRefused({
          reason: `the run is ${state.status}, so there is nothing to extend. Submit a new run instead.`,
          runId,
        });
      }

      if (maxSteps <= current) {
        return yield* new ExtendRefused({
          reason: `maxSteps ${maxSteps} is not above the current ${current}. Call extendRun({ runId: "${runId}", maxSteps }) with more than ${current}; the run has used ${state.transitions}.`,
          runId,
        });
      }

      const extended = {
        ...plan,
        envelope: { ...plan.envelope, maxSteps },
        version: plan.version + 1,
      };

      yield* store.writePlan(runId, extended);
      yield* store.writeRun(runId, {
        ...state,
        planVersion: extended.version,
        status: (yield* store.readPaused(runId)) ? "paused" : "running",
      });

      return yield* inspect(runId);
    });

    const scratchOf = (runId: string, docs: Docs) =>
      Effect.gen(function* copyRun() {
        const scratch = yield* RunStore.pipe(
          Effect.provide(Layer.fresh(RunStore.memory))
        );

        yield* scratch.open(runId);
        yield* scratch.replaceDocs(runId, docs);
        yield* Effect.forEach(
          yield* store.readJournal(runId),
          ([key, entry]) => scratch.writeJournal(runId, key, entry),
          { discard: true }
        );
        yield* Effect.forEach(
          yield* store.readFingerprints(runId),
          ([key, print]) => scratch.writeFingerprint(runId, key, print),
          { discard: true }
        );

        return scratch;
      });

    const revise = Effect.fn("RunHost.revise")(function* revise(
      runId: string,
      input: Schema.Json,
      dryRun: boolean
    ) {
      const opened = yield* loadRun(runId);
      const refuse = (reason: string) => new RevisionRefused({ reason, runId });

      if (opened.state.seeded === null) {
        return yield* refuse(
          `the run started before Mischief logged its inputs (answers, replies and seeded docs), so it cannot be rebuilt. Let it finish or abortRun it, then submitPlan the revised plan as a new run.`
        );
      }

      if (opened.state.status === "aborted") {
        return yield* refuse(
          `the run was aborted and stays ended. submitPlan the revised plan as a new run.`
        );
      }

      const plan = yield* hostGates(
        validatePlan(
          Option.match(decodeJsonObject(input), {
            onNone: () => input,
            onSome: (fields) => ({
              ...fields,
              version: opened.plan.version + 1,
            }),
          }),
          opened.state.seeded
        )
      ).pipe(
        Effect.mapError((refused) =>
          refuse(
            `the revised plan is invalid. Fix each problem and call reviseRun again:\n${refused.errors.map((error) => `- ${error}`).join("\n")}`
          )
        )
      );

      const refusals = judge.admits?.(plan) ?? [];

      if (refusals.length > 0) {
        return yield* refuse(
          `the revised plan is invalid. Fix each problem and call reviseRun again:\n${refusals.map((error) => `- ${error}`).join("\n")}`
        );
      }

      if (canonical(plan.envelope) !== canonical(opened.plan.envelope)) {
        return yield* refuse(
          `a revision keeps the run's envelope. To raise maxSteps call extendRun({ runId: "${runId}", maxSteps }); any other envelope change needs a new run.`
        );
      }

      const state: RunState = {
        ...opened.state,
        answers: {},
        asking: null,
        awaiting: [],
        capped: null,
        checkpoint: null,
        held: [],
        planVersion: plan.version,
        replies: [],
        revision: { diverged: false, from: opened.plan.version },
        status: (yield* store.readPaused(runId)) ? "paused" : "running",
        transitions: 0,
        value: null,
      };

      const watch: RevisionWatch = { dryRun: true, live: [], reused: [] };

      const target = yield* scratchOf(runId, yield* store.readDocs(runId));

      yield* target.writePlan(runId, plan);
      yield* target.writeRun(runId, state);

      const report = yield* driveSession(runId, { plan, state }, watch).pipe(
        Effect.provideService(RunStore, target),
        Effect.provideService(
          Operator,
          Operator.of({ notify: () => Effect.void })
        ),
        Effect.provideContext(context)
      );

      if (!dryRun) {
        yield* store.writePlan(runId, plan);
        yield* store.writeRun(runId, state);
      }

      return {
        dryRun,
        live: [...watch.live],
        reused: [...watch.reused],
        run: dryRun
          ? report
          : yield* reportOf(runId, plan, state).pipe(
              Effect.provideContext(context)
            ),
      } satisfies RevisionReport;
    });

    const unit = (runId: string) => withinRun(store, runId);

    const afterStored = <E, R>(effect: Effect.Effect<RunReport, E, R>) =>
      effect.pipe(
        Effect.flatMap((report) =>
          driver
            .stored(report, unit(report.runId)(advance(report.runId)))
            .pipe(Effect.orDie)
        )
      );

    return {
      abort: (runId, supersededBy) => unit(runId)(abort(runId, supersededBy)),
      advance: (runId) => unit(runId)(advance(runId)),
      answer: (runId, reply) => afterStored(unit(runId)(answer(runId, reply))),
      deliver: (line) =>
        afterStored(
          store
            .readMessage(line.replyTo)
            .pipe(
              Effect.flatMap((owner) =>
                Option.isSome(owner)
                  ? unit(owner.value)(deliver(line))
                  : deliver(line)
              )
            )
        ),
      extend: (runId, maxSteps) =>
        afterStored(unit(runId)(extend(runId, maxSteps))),
      inspect,
      pause: (runId) => unit(runId)(pause(runId)),
      read,
      resume: (runId) => afterStored(unit(runId)(resume(runId))),
      revise: (runId, input, dryRun) =>
        unit(runId)(revise(runId, input, dryRun)).pipe(
          Effect.flatMap((revision) =>
            dryRun
              ? Effect.succeed(revision)
              : afterStored(Effect.succeed(revision.run)).pipe(
                  Effect.map((run) => ({ ...revision, run }))
                )
          )
        ),
      submit: (runId, input, docs) =>
        afterStored(unit(runId)(submit(runId, input, docs))),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
