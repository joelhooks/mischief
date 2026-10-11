import { Context, Effect, Layer, Option } from "effect";
import type { Schema } from "effect";

import type { Plan } from "../plans/schema.js";
import type { Docs, RunState } from "./schema.js";

export type Journal = ReadonlyMap<string, Schema.Json>;

export class RunStore extends Context.Service<
  RunStore,
  {
    readonly readRun: (runId: string) => Effect.Effect<Option.Option<RunState>>;
    readonly writeRun: (runId: string, state: RunState) => Effect.Effect<void>;
    readonly readPlan: (
      runId: string,
      version: number
    ) => Effect.Effect<Option.Option<Plan>>;
    readonly writePlan: (runId: string, plan: Plan) => Effect.Effect<void>;
    readonly readJournal: (runId: string) => Effect.Effect<Journal>;
    readonly writeJournal: (
      runId: string,
      key: string,
      entry: Schema.Json
    ) => Effect.Effect<void>;
    readonly readDocs: (runId: string) => Effect.Effect<Docs>;
    readonly writeDoc: (
      runId: string,
      name: string,
      doc: Schema.Json
    ) => Effect.Effect<void>;
    readonly readPaused: (runId: string) => Effect.Effect<boolean>;
    readonly readMessage: (
      messageId: string
    ) => Effect.Effect<Option.Option<string>>;
    readonly writeMessage: (
      messageId: string,
      runId: string
    ) => Effect.Effect<void>;
    readonly writePaused: (
      runId: string,
      paused: boolean
    ) => Effect.Effect<void>;
  }
>()("@mischief/core/RunStore") {
  static readonly memory = Layer.sync(this, () => {
    const runs = new Map<string, RunState>();
    const plans = new Map<string, Plan>();
    const journals = new Map<string, Map<string, Schema.Json>>();
    const docs = new Map<string, Docs>();
    const paused = new Set<string>();
    const messages = new Map<string, string>();

    const journalOf = (runId: string) => {
      const existing = journals.get(runId);

      if (existing !== undefined) {
        return existing;
      }

      const created = new Map<string, Schema.Json>();
      journals.set(runId, created);

      return created;
    };

    return RunStore.of({
      readDocs: (runId) => Effect.sync(() => ({ ...docs.get(runId) })),
      readJournal: (runId) => Effect.sync(() => new Map(journalOf(runId))),
      readMessage: (messageId) =>
        Effect.sync(() => Option.fromUndefinedOr(messages.get(messageId))),
      readPaused: (runId) => Effect.sync(() => paused.has(runId)),
      readPlan: (runId, version) =>
        Effect.sync(() =>
          Option.fromUndefinedOr(plans.get(`${runId}#${version}`))
        ),
      readRun: (runId) =>
        Effect.sync(() => Option.fromUndefinedOr(runs.get(runId))),
      writeDoc: (runId, name, doc) =>
        Effect.sync(() => {
          docs.set(runId, { ...docs.get(runId), [name]: structuredClone(doc) });
        }),
      writeJournal: (runId, key, entry) =>
        Effect.sync(() => {
          journalOf(runId).set(key, structuredClone(entry));
        }),
      writeMessage: (messageId, runId) =>
        Effect.sync(() => {
          messages.set(messageId, runId);
        }),
      writePaused: (runId, value) =>
        Effect.sync(() => {
          if (value) {
            paused.add(runId);
          } else {
            paused.delete(runId);
          }
        }),
      writePlan: (runId, plan) =>
        Effect.sync(() => {
          plans.set(`${runId}#${plan.version}`, structuredClone(plan));
        }),
      writeRun: (runId, state) =>
        Effect.sync(() => {
          runs.set(runId, structuredClone(state));
        }),
    });
  });
}
