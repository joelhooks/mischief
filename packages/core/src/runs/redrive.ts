import { Context, Effect, Layer, Option, Result, Schema } from "effect";

import type { AgentConfig, Envelope } from "../plans/schema.js";
import { StepFailed } from "../steps/step-failed.js";
import type { StepCall } from "../steps/step-failed.js";
import { RunStore } from "./run-store.js";

const Attempts = Schema.Int.check(Schema.isGreaterThan(0));

export const RedriveAttempts = Context.Reference<number>(
  "@mischief/core/RedriveAttempts",
  {
    defaultValue: () => 3,
  }
);

export const redriveAttemptsLayer = (value: string | undefined) =>
  Layer.effect(
    RedriveAttempts,
    Schema.decodeEffect(Attempts)(
      value === undefined || value.trim() === "" ? 3 : Number(value)
    ).pipe(Effect.orDie)
  );

export const ThinkAttemptSchema = Schema.Struct({
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  level: Schema.String,
  model: Schema.String,
  pending: Schema.Boolean,
  unfinished: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const decode = Schema.decodeUnknownOption(ThinkAttemptSchema);

export const settleThinkAttempt = (
  call: StepCall,
  journal: Map<string, Schema.Json>
) =>
  Effect.gen(function* settleAttempt() {
    const key = `think-attempt:${call.key}#${call.visit}@${call.epoch}`;
    const attempt = decode(journal.get(key));

    if (Option.isSome(attempt) && attempt.value.pending) {
      const entry = { ...attempt.value, pending: false };
      journal.set(key, entry);
      yield* (yield* RunStore).writeJournal(call.runId, key, entry);
    }
  });

export const attemptedThink = <A, E>(
  call: {
    readonly agent: AgentConfig;
    readonly ceiling: Envelope["maxThinking"];
    readonly epoch: number;
    readonly key: string;
    readonly runId: string;
    readonly visit: number;
  },
  journal: Map<string, Schema.Json>,
  effect: Effect.Effect<A, E>,
  exhausted: (reason: string) => Effect.Effect<void>
) =>
  Effect.gen(function* startThinkAttempt() {
    const store = yield* RunStore;
    const cap = yield* RedriveAttempts;
    const key = `think-attempt:${call.key}#${call.visit}@${call.epoch}`;
    const previous = decode(journal.get(key));

    const before = Option.getOrElse(previous, () => ({
      attempts: 0,
      level: call.agent.thinking ?? `host default (ceiling ${call.ceiling})`,
      model: call.agent.model ?? "host default",
      pending: false,
      unfinished: 0,
    }));

    const unfinished = before.unfinished + (before.pending ? 1 : 0);

    const record = (entry: typeof ThinkAttemptSchema.Type) =>
      Effect.gen(function* recordAttempt() {
        journal.set(key, entry);
        yield* store.writeJournal(call.runId, key, entry);
      });

    if (unfinished >= cap) {
      yield* record({ ...before, pending: false, unfinished });

      const reason = `Step "${call.key}" using model "${before.model}" at thinking level "${before.level}" was cut before finishing on ${unfinished} attempts (MISCHIEF_REDRIVE_ATTEMPTS=${cap}), likely by the host's handler budget or restarts. Revise this step with smaller input or a lower thinking level, or raise the host's handler budget, then call reviseRun and poll inspectRun({ runId: "${call.runId}" }).`;

      yield* exhausted(reason);

      return yield* new StepFailed({ key: call.key, reason });
    }

    const started = {
      ...before,
      attempts: before.attempts + 1,
      pending: true,
      unfinished,
    };

    yield* record(started);
    yield* store.commit(call.runId);

    const outcome = yield* Effect.result(effect);

    if (Result.isFailure(outcome)) {
      yield* record({ ...started, pending: false });

      return yield* Effect.fail(outcome.failure);
    }

    return outcome.success;
  });
