import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import type { Schema } from "effect";

import type { Plan } from "../plans/schema.js";
import { RunLeftUncommitted } from "./run-left-uncommitted.js";
import { RunWriteOutsideUnit } from "./run-write-outside-unit.js";
import type { Docs, RunState } from "./schema.js";

export type Journal = ReadonlyMap<string, Schema.Json>;

export type Fingerprints = ReadonlyMap<string, string>;

export interface RunChanges {
  readonly docs: ReadonlyMap<string, Schema.Json>;
  readonly fingerprints: ReadonlyMap<string, string>;
  readonly journal: ReadonlyMap<string, Schema.Json>;
  readonly messages: ReadonlyMap<string, string>;
  readonly paused: boolean | undefined;
  readonly plans: ReadonlyMap<number, Plan>;
  readonly replaceDocs: boolean;
  readonly run: RunState | undefined;
}

export interface RunReads {
  readonly readRun: (runId: string) => Effect.Effect<Option.Option<RunState>>;
  readonly readPlan: (
    runId: string,
    version: number
  ) => Effect.Effect<Option.Option<Plan>>;
  readonly readJournal: (runId: string) => Effect.Effect<Journal>;
  readonly readFingerprints: (runId: string) => Effect.Effect<Fingerprints>;
  readonly readDocs: (runId: string) => Effect.Effect<Docs>;
  readonly readPaused: (runId: string) => Effect.Effect<boolean>;
  readonly readMessage: (
    messageId: string
  ) => Effect.Effect<Option.Option<string>>;
}

export interface RunBackend extends RunReads {
  readonly apply: (runId: string, changes: RunChanges) => Effect.Effect<void>;
}

export type RunUnitOfWork = RunReads & {
  readonly writeRun: (runId: string, state: RunState) => Effect.Effect<void>;
  readonly writePlan: (runId: string, plan: Plan) => Effect.Effect<void>;
  readonly writeJournal: (
    runId: string,
    key: string,
    entry: Schema.Json
  ) => Effect.Effect<void>;
  readonly writeFingerprint: (
    runId: string,
    key: string,
    fingerprint: string
  ) => Effect.Effect<void>;
  readonly replaceDocs: (runId: string, docs: Docs) => Effect.Effect<void>;
  readonly writeDoc: (
    runId: string,
    name: string,
    doc: Schema.Json
  ) => Effect.Effect<void>;
  readonly writeMessage: (
    messageId: string,
    runId: string
  ) => Effect.Effect<void>;
  readonly writePaused: (runId: string, paused: boolean) => Effect.Effect<void>;
  readonly open: (runId: string) => Effect.Effect<void>;
  readonly commit: (runId: string) => Effect.Effect<void>;
  readonly discard: (runId: string) => Effect.Effect<void>;
  readonly close: (runId: string) => Effect.Effect<void>;
};

interface Pending {
  readonly docs: Map<string, Schema.Json>;
  readonly fingerprints: Map<string, string>;
  readonly journal: Map<string, Schema.Json>;
  readonly messages: Map<string, string>;
  paused: boolean | undefined;
  readonly plans: Map<number, Plan>;
  replaceDocs: boolean;
  run: RunState | undefined;
}

const emptyPending = (): Pending => ({
  docs: new Map(),
  fingerprints: new Map(),
  journal: new Map(),
  messages: new Map(),
  paused: undefined,
  plans: new Map(),
  replaceDocs: false,
  run: undefined,
});

const writesOf = (pending: Pending) => [
  ...(pending.run === undefined ? [] : ["writeRun"]),
  ...[...pending.plans.keys()].map((version) => `writePlan v${version}`),
  ...[...pending.journal.keys()].map((key) => `writeJournal ${key}`),
  ...[...pending.fingerprints.keys()].map((key) => `writeFingerprint ${key}`),
  ...(pending.replaceDocs ? ["replaceDocs"] : []),
  ...[...pending.docs.keys()].map((name) => `writeDoc ${name}`),
  ...[...pending.messages.keys()].map((id) => `writeMessage ${id}`),
  ...(pending.paused === undefined ? [] : ["writePaused"]),
];

const isEmpty = (pending: Pending) =>
  pending.docs.size === 0 &&
  pending.fingerprints.size === 0 &&
  pending.journal.size === 0 &&
  pending.messages.size === 0 &&
  pending.paused === undefined &&
  pending.plans.size === 0 &&
  !pending.replaceDocs &&
  pending.run === undefined;

export const bufferedRunStore = (backend: RunBackend): RunUnitOfWork => {
  const buffers = new Map<string, Pending>();
  const units = new Map<string, number>();

  const pendingOf = (runId: string) => {
    const existing = buffers.get(runId);

    if (existing !== undefined) {
      return existing;
    }

    const created = emptyPending();
    buffers.set(runId, created);

    return created;
  };

  const buffer = (
    runId: string,
    write: string,
    change: (pending: Pending) => void
  ) =>
    Effect.suspend(() => {
      if (!units.has(runId)) {
        return Effect.die(new RunWriteOutsideUnit({ runId, write }));
      }

      change(pendingOf(runId));

      return Effect.void;
    });

  const commit = (runId: string) =>
    Effect.suspend(() => {
      const pending = buffers.get(runId);
      buffers.delete(runId);

      return pending === undefined || isEmpty(pending)
        ? Effect.void
        : backend.apply(runId, pending);
    });

  return {
    close: (runId) =>
      Effect.suspend(() => {
        const depth = (units.get(runId) ?? 1) - 1;

        if (depth > 0) {
          units.set(runId, depth);

          return Effect.void;
        }

        units.delete(runId);

        const pending = buffers.get(runId);
        buffers.delete(runId);

        return pending === undefined || isEmpty(pending)
          ? Effect.void
          : Effect.die(
              new RunLeftUncommitted({ runId, writes: writesOf(pending) })
            );
      }),
    commit,
    discard: (runId) =>
      Effect.sync(() => {
        buffers.delete(runId);
      }),
    open: (runId) =>
      Effect.sync(() => {
        units.set(runId, (units.get(runId) ?? 0) + 1);
      }),
    readDocs: (runId) =>
      backend.readDocs(runId).pipe(
        Effect.map((stored) => {
          const pending = buffers.get(runId);

          if (pending === undefined) {
            return stored;
          }

          const written = Object.fromEntries(
            structuredClone([...pending.docs])
          );

          return pending.replaceDocs ? written : { ...stored, ...written };
        })
      ),
    readFingerprints: (runId) =>
      backend
        .readFingerprints(runId)
        .pipe(
          Effect.map(
            (stored) =>
              new Map([...stored, ...(buffers.get(runId)?.fingerprints ?? [])])
          )
        ),
    readJournal: (runId) =>
      backend
        .readJournal(runId)
        .pipe(
          Effect.map(
            (stored) =>
              new Map([
                ...stored,
                ...structuredClone([...(buffers.get(runId)?.journal ?? [])]),
              ])
          )
        ),
    readMessage: (messageId) =>
      Effect.suspend(() => {
        for (const pending of buffers.values()) {
          const runId = pending.messages.get(messageId);

          if (runId !== undefined) {
            return Effect.succeed(Option.some(runId));
          }
        }

        return backend.readMessage(messageId);
      }),
    readPaused: (runId) =>
      Effect.suspend(() => {
        const paused = buffers.get(runId)?.paused;

        return paused === undefined
          ? backend.readPaused(runId)
          : Effect.succeed(paused);
      }),
    readPlan: (runId, version) =>
      Effect.suspend(() => {
        const plan = buffers.get(runId)?.plans.get(version);

        return plan === undefined
          ? backend.readPlan(runId, version)
          : Effect.succeed(Option.some(structuredClone(plan)));
      }),
    readRun: (runId) =>
      Effect.suspend(() => {
        const run = buffers.get(runId)?.run;

        return run === undefined
          ? backend.readRun(runId)
          : Effect.succeed(Option.some(structuredClone(run)));
      }),
    replaceDocs: (runId, docs) =>
      buffer(runId, "replaceDocs", (pending) => {
        pending.replaceDocs = true;
        pending.docs.clear();

        for (const [name, doc] of Object.entries(docs)) {
          pending.docs.set(name, structuredClone(doc));
        }
      }),
    writeDoc: (runId, name, doc) =>
      buffer(runId, "writeDoc", (pending) => {
        pending.docs.set(name, structuredClone(doc));
      }),
    writeFingerprint: (runId, key, fingerprint) =>
      buffer(runId, "writeFingerprint", (pending) => {
        pending.fingerprints.set(key, fingerprint);
      }),
    writeJournal: (runId, key, entry) =>
      buffer(runId, "writeJournal", (pending) => {
        pending.journal.delete(key);
        pending.journal.set(key, structuredClone(entry));
      }),
    writeMessage: (messageId, runId) =>
      buffer(runId, "writeMessage", (pending) => {
        pending.messages.set(messageId, runId);
      }),
    writePaused: (runId, paused) =>
      buffer(runId, "writePaused", (pending) => {
        pending.paused = paused;
      }),
    writePlan: (runId, plan) =>
      buffer(runId, "writePlan", (pending) => {
        pending.plans.set(plan.version, structuredClone(plan));
      }),
    writeRun: (runId, state) =>
      buffer(runId, "writeRun", (pending) => {
        pending.run = structuredClone(state);
      }),
  };
};

export const memoryRunBackend = (): RunBackend => {
  const runs = new Map<string, RunState>();
  const plans = new Map<string, Plan>();
  const journals = new Map<string, Map<string, Schema.Json>>();
  const docs = new Map<string, Docs>();
  const paused = new Set<string>();
  const messages = new Map<string, string>();
  const fingerprints = new Map<string, Map<string, string>>();

  const apply = (runId: string, changes: RunChanges) => {
    const journal = new Map(journals.get(runId));

    for (const [key, entry] of changes.journal) {
      journal.delete(key);
      journal.set(key, structuredClone(entry));
    }

    const written = Object.fromEntries(structuredClone([...changes.docs]));

    const nextDocs = changes.replaceDocs
      ? written
      : { ...docs.get(runId), ...written };

    const prints = new Map([
      ...(fingerprints.get(runId) ?? []),
      ...changes.fingerprints,
    ]);

    const run =
      changes.run === undefined ? undefined : structuredClone(changes.run);

    const versions = [...changes.plans].map(
      ([version, plan]) =>
        [`${runId}#${version}`, structuredClone(plan)] as const
    );

    journals.set(runId, journal);
    docs.set(runId, nextDocs);
    fingerprints.set(runId, prints);

    for (const [at, plan] of versions) {
      plans.set(at, plan);
    }

    for (const [messageId, owner] of changes.messages) {
      messages.set(messageId, owner);
    }

    if (changes.paused === true) {
      paused.add(runId);
    }

    if (changes.paused === false) {
      paused.delete(runId);
    }

    if (run !== undefined) {
      runs.set(runId, run);
    }
  };

  return {
    apply: (runId, changes) =>
      Effect.sync(() => {
        apply(runId, changes);
      }),
    readDocs: (runId) =>
      Effect.sync(() => structuredClone({ ...docs.get(runId) })),
    readFingerprints: (runId) =>
      Effect.sync(() => new Map(fingerprints.get(runId))),
    readJournal: (runId) =>
      Effect.sync(() => structuredClone(new Map(journals.get(runId)))),
    readMessage: (messageId) =>
      Effect.sync(() => Option.fromUndefinedOr(messages.get(messageId))),
    readPaused: (runId) => Effect.sync(() => paused.has(runId)),
    readPlan: (runId, version) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(plans.get(`${runId}#${version}`)).pipe(
          Option.map((plan) => structuredClone(plan))
        )
      ),
    readRun: (runId) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(runs.get(runId)).pipe(
          Option.map((state) => structuredClone(state))
        )
      ),
  };
};

export class RunStore extends Context.Service<RunStore, RunUnitOfWork>()(
  "@mischief/core/RunStore"
) {
  static readonly memory = Layer.sync(this, () =>
    bufferedRunStore(memoryRunBackend())
  );
}

export const withinRun =
  (store: RunUnitOfWork, runId: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      store.open(runId),
      () => effect,
      (_, exit) =>
        (Exit.isSuccess(exit) ||
        (Cause.hasFails(exit.cause) &&
          !Cause.hasDies(exit.cause) &&
          !Cause.hasInterrupts(exit.cause))
          ? store.commit(runId)
          : store.discard(runId)
        ).pipe(Effect.andThen(store.close(runId)))
    );
