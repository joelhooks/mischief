import { Context, Effect, Layer, Option, Schema } from "effect";

import type { PlanRefused } from "../plans/validate.js";
import { validatePlan } from "../plans/validate.js";
import { Operator } from "../steps/operator.js";
import { AnswerRefused } from "./answer-refused.js";
import { closeOpenAsks } from "./close-asks.js";
import { ExtendRefused } from "./extend-refused.js";
import { canonical } from "./fingerprint.js";
import { ReplyRefused } from "./reply-refused.js";
import { RevisionRefused } from "./revision-refused.js";
import { RunStore } from "./run-store.js";
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
import type { Delivery, RevisionWatch, StepServices } from "./session.js";
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

    const drive = Effect.fn("RunHost.drive")(function* drive(
      runId: string,
      delivery?: Delivery
    ) {
      const opened = yield* loadRun(runId);

      if (terminalStatuses.has(opened.state.status)) {
        return yield* reportOf(runId, opened.plan, opened.state);
      }

      return yield* driveSession(runId, opened, delivery);
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
      if (Option.isSome(yield* store.readRun(runId))) {
        return yield* drive(runId).pipe(Effect.orDie);
      }

      const plan = yield* checkSubmission(input, docs);

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
        revision: null,
        seeded: Object.keys(docs).toSorted(),
        status: "running",
        transitions: 0,
        value: null,
      };

      yield* store.writeRun(runId, fresh);

      return yield* drive(runId).pipe(Effect.orDie);
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

      return yield* drive(runId, { kind: "answer", reply });
    });

    const pause = Effect.fn("RunHost.pause")(function* pause(runId: string) {
      yield* store.writePaused(runId, true);

      return yield* inspect(runId);
    });

    const resume = Effect.fn("RunHost.resume")(function* resume(runId: string) {
      yield* store.writePaused(runId, false);

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

      yield* store.writeRun(runId, {
        ...state,
        replies: [...state.replies, { body: line.body, key: open.key }],
      });

      return yield* drive(runId).pipe(Effect.orDie);
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
      yield* store.writeRun(runId, { ...state, planVersion: extended.version });

      return yield* drive(runId);
    });

    const scratchOf = (runId: string, docs: Docs) =>
      Effect.gen(function* copyRun() {
        const scratch = yield* RunStore.pipe(
          Effect.provide(Layer.fresh(RunStore.memory))
        );

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

      const plan = yield* validatePlan(
        Option.match(decodeJsonObject(input), {
          onNone: () => input,
          onSome: (fields) => ({
            ...fields,
            version: opened.plan.version + 1,
          }),
        }),
        opened.state.seeded
      ).pipe(
        Effect.mapError((refused) =>
          refuse(
            `the revised plan is invalid. Fix each problem and call reviseRun again:\n${refused.errors.map((error) => `- ${error}`).join("\n")}`
          )
        )
      );

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
        status: "running",
        transitions: 0,
        value: null,
      };

      const watch: RevisionWatch = { dryRun, live: [], reused: [] };

      const target = dryRun
        ? yield* scratchOf(runId, yield* store.readDocs(runId))
        : store;

      yield* target.writePlan(runId, plan);
      yield* target.writeRun(runId, state);

      const report = yield* driveSession(
        runId,
        { plan, state },
        undefined,
        watch
      ).pipe(
        Effect.provideService(RunStore, target),
        Effect.provideService(
          Operator,
          dryRun ? Operator.of({ notify: () => Effect.void }) : operator
        ),
        Effect.provideContext(context)
      );

      return {
        dryRun,
        live: [...watch.live],
        reused: [...watch.reused],
        run: report,
      } satisfies RevisionReport;
    });

    return {
      abort,
      advance: (runId) => drive(runId),
      answer,
      deliver,
      extend,
      inspect,
      pause,
      read,
      resume,
      revise,
      submit,
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
