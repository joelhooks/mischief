import { Context, Effect, Layer, Option, Schema } from "effect";

import { DocKey } from "../plans/schema.js";
import { PlanRefused, validatePlan } from "../plans/validate.js";
import { AnswerRefused } from "./answer-refused.js";
import { ExtendRefused } from "./extend-refused.js";
import { ReplyRefused } from "./reply-refused.js";
import { RunStore } from "./run-store.js";
import { terminalStatuses } from "./schema.js";
import type { Docs, ReplyLine, RunReport, RunState } from "./schema.js";
import { driveSession, reportOf } from "./session.js";
import type { Delivery, StepServices } from "./session.js";
import { UnknownRun } from "./unknown-run.js";

const decodeJsonObject = Schema.decodeUnknownOption(Schema.JsonObject);

const docKeyGuard = Schema.is(DocKey);

const isDocKey = (name: string): boolean => docKeyGuard(name);

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
    readonly inspect: (runId: string) => Effect.Effect<RunReport, UnknownRun>;
    readonly pause: (runId: string) => Effect.Effect<RunReport, UnknownRun>;
    readonly resume: (runId: string) => Effect.Effect<RunReport, UnknownRun>;
    readonly abort: (runId: string) => Effect.Effect<RunReport, UnknownRun>;
  }
>()("@mischief/core/RunHost", {
  make: Effect.gen(function* makeRunHost() {
    const context = yield* Effect.context<StepServices>();
    const store = yield* RunStore;

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

    const submit = Effect.fn("RunHost.submit")(function* submit(
      runId: string,
      input: Schema.Json,
      docs: Docs = {}
    ) {
      if (Option.isSome(yield* store.readRun(runId))) {
        return yield* drive(runId).pipe(Effect.orDie);
      }

      const badNames = Object.keys(docs).filter((name) => !isDocKey(name));

      if (badNames.length > 0) {
        return yield* new PlanRefused({
          errors: badNames.map(
            (name) =>
              `docs.${name}: seed doc names are lowercase, start with a letter and use only a-z, 0-9, _ and -, up to 64 characters`
          ),
        });
      }

      const plan = yield* validatePlan(
        Option.match(decodeJsonObject(input), {
          onNone: () => input,
          onSome: (fields) => ({ ...fields, version: 1 }),
        })
      );

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
        planVersion: plan.version,
        replies: [],
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

    const abort = Effect.fn("RunHost.abort")(function* abort(runId: string) {
      const { plan, state } = yield* loadRun(runId);

      if (terminalStatuses.has(state.status)) {
        return yield* reportOf(runId, plan, state).pipe(
          Effect.provideContext(context)
        );
      }

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

    return {
      abort,
      advance: (runId) => drive(runId),
      answer,
      deliver,
      extend,
      inspect,
      pause,
      resume,
      submit,
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
