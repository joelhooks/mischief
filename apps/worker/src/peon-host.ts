import {
  emptyPeonUsage,
  PeonIndexEntry,
  PeonRefused,
  peonIdleAlarm,
  peonTransition,
} from "@mischief/core";
import type {
  PeonEvent,
  PeonPromptLog,
  PeonReport,
  PeonTemplate,
  PeonTurn,
} from "@mischief/core";
import { Clock, Effect, Schema } from "effect";

import type { PeonBox } from "./peon-box.js";
import { hashPeonText as hashText } from "./peon-crypto.js";
import {
  PeonBoxCloned,
  PeonBoxCreated,
  PeonBoxState,
  PeonBoxTurn,
} from "./peon-state.js";
import type {
  PeonCompleted,
  PeonPending,
  PeonStoredValue,
} from "./peon-state.js";

interface Completion {
  readonly requestId: string;
  readonly value: typeof PeonCompleted.Type;
  readonly log?: typeof PeonPromptLog.Type | undefined;
}

export interface PeonPersistence {
  readonly load: Effect.Effect<PeonStoredValue | undefined>;
  readonly commit: (
    stored: PeonStoredValue,
    alarm: number | null,
    completed?: Completion
  ) => Effect.Effect<void>;
  readonly completed: (
    requestId: string
  ) => Effect.Effect<typeof PeonCompleted.Type | undefined>;
}

export interface PeonHostOptions {
  readonly storage: PeonPersistence;
  readonly box: PeonBox;
  readonly guardMs: number;
  readonly publish: (
    entry: typeof PeonIndexEntry.Type
  ) => Effect.Effect<void, PeonRefused>;
  readonly reply: (
    to: string,
    messageId: string,
    peonId: string,
    text: string
  ) => Effect.Effect<void, PeonRefused>;
  readonly reserveClone: (
    id: string,
    source: typeof PeonReport.Type,
    requestId: string
  ) => Effect.Effect<void, PeonRefused>;
  readonly clone: (
    id: string,
    source: typeof PeonReport.Type,
    requestId: string
  ) => Effect.Effect<typeof PeonReport.Type, PeonRefused>;
}

interface CommandOptions {
  readonly text?: string | undefined;
  readonly newPeonId?: string | undefined;
  readonly sender?: string | undefined;
  readonly mail?: boolean;
  readonly defer?: boolean;
}

const failure = (reason: string) => new PeonRefused({ reason });

const reportWithPending = (
  stored: PeonStoredValue
): typeof PeonReport.Type => ({
  ...stored.report,
  pending:
    stored.pending === null
      ? null
      : { kind: stored.pending.kind, requestId: stored.pending.requestId },
});

const indexOf = Schema.decodeUnknownSync(PeonIndexEntry);

const BoxAcknowledgement = Schema.Struct({ state: Schema.Literal("idle") });

const acknowledgedStates = {
  destroy: "destroyed",
  hibernate: "hibernated",
  resume: "idle",
  suspend: "suspended",
} as const;

const addUsage = (
  left: (typeof PeonReport.Type)["usage"],
  right: (typeof PeonReport.Type)["usage"]
) => ({
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  input: left.input + right.input,
  output: left.output + right.output,
  total: left.total + right.total,
});

const peonAtTarget = (
  kind: (typeof PeonPending.Type)["kind"],
  state: (typeof PeonReport.Type)["state"]
) => {
  if (kind === "suspend") {
    return state === "suspended" || state === "hibernated";
  }

  return (
    (kind === "resume" && state === "idle") ||
    (kind === "hibernate" && state === "hibernated")
  );
};

export const assertPeonSpawnable = (template: typeof PeonTemplate.Type) => {
  if (template.restriction === "read-only") {
    return Effect.fail(
      failure(
        "The read-only template cannot be isolated by the full-tool box in slice 1; use a Mischief workspace think instead of spawnPeon."
      )
    );
  }

  if (template.model !== "opus" && template.model !== "sol") {
    return Effect.fail(
      failure(
        `Model ${template.model} is not in the box map; silently substituting would run the wrong model. Use opus or sol in spawnPeon overrides; wider models are a later slice.`
      )
    );
  }

  if (template.workspace === undefined) {
    return Effect.fail(
      failure(
        "The template has no pinned workspace; cloning an unpinned repository would run unreviewed code. Pass overrides.workspace with owner/repo and a 40-hex sha to spawnPeon."
      )
    );
  }

  return Effect.void;
};

export const peonHost = ({
  storage,
  box,
  publish,
  clone,
  reserveClone,
  reply,
  guardMs,
}: PeonHostOptions) => {
  const requirePeon = storage.load.pipe(
    Effect.flatMap((stored) =>
      stored === undefined
        ? Effect.fail(
            failure(
              "Unknown peon. Call spawnPeon before promptPeon; listPeons shows live ids."
            )
          )
        : Effect.succeed(stored)
    )
  );

  const commit = Effect.fn("Peon.commit")(function* commit(
    stored: PeonStoredValue
  ) {
    const now = yield* Clock.currentTimeMillis;

    const at =
      stored.pending === null
        ? peonIdleAlarm(
            stored.report.state,
            stored.idleAt,
            stored.report.resolvedTemplate
          )
        : now + guardMs;

    yield* storage.commit(stored, at);
  });

  const move = Effect.fn("Peon.transition")(function* move(
    stored: PeonStoredValue,
    event: typeof PeonEvent.Type
  ) {
    const state = peonTransition(stored.report.state, event);

    if (
      state === stored.report.state &&
      event !== "CLONE" &&
      event !== "BOX_LOST"
    ) {
      return yield* failure(
        `Peon ${stored.report.peonId} cannot accept ${event} while ${stored.report.state}; changing state would lose in-flight work. Use inspectPeon, then resumePeon for a sleeping box or wait for its pending turn.`
      );
    }

    const now = yield* Clock.currentTimeMillis;
    const report = { ...stored.report, state, updatedAt: now };

    if (state === "destroyed") {
      report.destroyedAt = now;
    }

    return { ...stored, report };
  });

  const prepare = Effect.fn("Peon.prepare")(function* prepare(
    current: PeonStoredValue,
    pending: typeof PeonPending.Type
  ) {
    let stored = current;

    if (
      (pending.kind === "spawn" || pending.kind === "resume") &&
      stored.report.state === "suspended"
    ) {
      stored = yield* move(stored, "RESUME");
      yield* commit(stored);
    }

    if (pending.kind === "hibernate" && stored.report.state === "suspended") {
      stored = yield* move(stored, "HIBERNATE");
      yield* commit(stored);
    }

    if (pending.kind === "prompt" && stored.report.state !== "running") {
      if (stored.report.state !== "attaching") {
        stored = yield* move(stored, "RESUME");
        yield* commit(stored);
      }

      yield* publish(indexOf(stored.report));

      yield* box.call(
        stored.report.peonId,
        "resume",
        { requestId: pending.resumeRequestId },
        BoxAcknowledgement
      );
      stored = yield* move(stored, "TURN_DONE");
      stored = yield* move(stored, "PROMPT");
      yield* commit(stored);
    }

    return stored;
  });

  const perform = Effect.fn("Peon.perform")(function* perform(
    stored: PeonStoredValue,
    pending: typeof PeonPending.Type
  ) {
    const id = stored.report.peonId;
    let next = stored;
    let turn: typeof PeonTurn.Type | undefined;
    let clonedReport: typeof PeonReport.Type | undefined;

    switch (pending.kind) {
      case "spawn": {
        const resolved = stored.report.resolvedTemplate;

        const template = {
          limits: resolved.limits,
          model: resolved.model,
          system: resolved.system,
          thinking: resolved.thinking,
          tools: resolved.tools,
          warm: resolved.warm,
          workspace: resolved.workspace,
        };

        yield* box.call(
          id,
          "spawn",
          { peonId: id, requestId: pending.boxRequestId, template },
          PeonBoxCreated
        );
        next = yield* move(stored, "TURN_DONE");
        break;
      }

      case "prompt": {
        turn = yield* box.call(
          id,
          "prompt",
          { requestId: pending.boxRequestId, text: pending.text ?? "" },
          PeonBoxTurn
        );
        next = yield* move(stored, "TURN_DONE");
        next = {
          ...next,
          report: {
            ...next.report,
            lastTurn: turn,
            usage: addUsage(next.report.usage, turn.usage),
          },
        };
        break;
      }

      case "clone": {
        if (pending.newPeonId === undefined) {
          return yield* failure(
            "Stored clone has no target id. Inspect the peon checkpoint before retrying clonePeon."
          );
        }

        yield* reserveClone(
          pending.newPeonId,
          stored.report,
          pending.requestId
        ).pipe(
          Effect.catchTag("PeonRefused", (refusal) =>
            commit({ ...stored, pending: null }).pipe(
              Effect.andThen(Effect.fail(refusal))
            )
          )
        );

        yield* box.call(
          id,
          "clone",
          { newPeonId: pending.newPeonId, requestId: pending.boxRequestId },
          PeonBoxCloned
        );
        clonedReport = yield* clone(
          pending.newPeonId,
          stored.report,
          pending.requestId
        );
        break;
      }

      case "destroy":
      case "hibernate":
      case "resume":
      case "suspend": {
        yield* box.call(
          id,
          pending.kind,
          { requestId: pending.boxRequestId },
          Schema.Struct({
            state: Schema.Literal(acknowledgedStates[pending.kind]),
          })
        );

        if (pending.kind === "resume") {
          next = yield* move(stored, "TURN_DONE");
        } else if (pending.kind === "destroy") {
          next = yield* move(stored, "DESTROY");
        }

        break;
      }

      default: {
        return yield* Effect.die(
          "The stored peon operation is unknown; refusing an unvalidated box effect. Decode the checkpoint with PeonStored before resuming."
        );
      }
    }

    return { clonedReport, stored: next, turn };
  });

  const drive = Effect.fn("Peon.drive")(function* drive(): Effect.fn.Return<
    typeof PeonReport.Type,
    PeonRefused
  > {
    const current = yield* requirePeon;
    const { pending } = current;

    if (pending === null) {
      yield* publish(indexOf(current.report));
      yield* commit(current);

      return current.report;
    }

    const prepared = yield* prepare(current, pending);

    yield* publish(indexOf(prepared.report));

    const performed = yield* perform(prepared, pending);
    const now = yield* Clock.currentTimeMillis;
    const { stored } = performed;

    const finished: PeonStoredValue = {
      ...stored,
      idleAt: stored.report.state === "idle" ? now : stored.idleAt,
      pending: null,
      report: { ...stored.report, fault: null, updatedAt: now },
    };

    yield* publish(indexOf(finished.report));
    const { turn } = performed;

    if (
      pending.mail === true &&
      pending.sender !== undefined &&
      turn !== undefined
    ) {
      yield* reply(
        pending.sender,
        pending.requestId,
        finished.report.peonId,
        turn.output
      );
    }

    const report = performed.clonedReport ?? finished.report;

    const log =
      turn === undefined
        ? undefined
        : {
            requestId: pending.requestId,
            sender: pending.sender,
            textHash: pending.textHash ?? "",
            usage: turn.usage,
            wallMs: turn.wallMs,
          };

    yield* storage.commit(
      finished,
      peonIdleAlarm(
        finished.report.state,
        finished.idleAt,
        finished.report.resolvedTemplate
      ),
      {
        log,
        requestId: pending.requestId,
        value: { hash: pending.inputHash, report },
      }
    );

    return report;
  });

  const recordFault = Effect.fn("Peon.recordFault")(function* recordFault(
    fault: PeonRefused
  ) {
    const stored = yield* requirePeon;

    if (stored.pending === null) {
      return yield* fault;
    }

    const state =
      stored.report.state === "destroyed"
        ? "destroyed"
        : peonTransition(stored.report.state, "BOX_LOST");

    const lost = {
      ...stored,
      report: { ...stored.report, fault: fault.reason, state },
    };

    yield* commit(lost);

    if (lost.report.state !== "destroyed") {
      yield* publish(indexOf(lost.report));
    }

    return yield* fault;
  });

  const recover = drive().pipe(Effect.catchTag("PeonRefused", recordFault));

  const begin = Effect.fn("Peon.begin")(function* begin(
    kind: (typeof PeonPending.Type)["kind"],
    requestId: string,
    event: typeof PeonEvent.Type,
    options: CommandOptions = {}
  ) {
    const inputHash = yield* hashText(
      JSON.stringify({ kind, newPeonId: options.newPeonId, text: options.text })
    );

    const completed = yield* storage.completed(requestId);

    if (completed !== undefined) {
      if (completed.hash !== inputHash) {
        return yield* failure(
          `requestId ${requestId} already completed with different input; reusing it would conceal changed work. Use a new requestId for a new operation.`
        );
      }

      return completed.report;
    }

    let stored = yield* requirePeon;

    if (stored.pending !== null) {
      if (
        stored.pending.requestId === requestId &&
        stored.pending.inputHash === inputHash
      ) {
        return options.defer === true ? stored.report : yield* recover;
      }

      if (kind !== "destroy" || stored.report.fault === null) {
        return yield* failure(
          `Peon ${stored.report.peonId} already has pending ${stored.pending.kind}; a second call would race its workspace. Use inspectPeon and retry after that request completes, or destroyPeon after a recorded box fault.`
        );
      }

      stored = { ...stored, pending: null };
    }

    if (peonAtTarget(kind, stored.report.state)) {
      yield* storage.commit(
        stored,
        peonIdleAlarm(
          stored.report.state,
          stored.idleAt,
          stored.report.resolvedTemplate
        ),
        { requestId, value: { hash: inputHash, report: stored.report } }
      );

      return stored.report;
    }

    const pending: typeof PeonPending.Type = {
      boxRequestId: yield* hashText(
        JSON.stringify([stored.report.peonId, kind, requestId, "main"])
      ),
      inputHash,
      kind,
      mail: options.mail ?? false,
      newPeonId: options.newPeonId,
      requestId,
      resumeRequestId: yield* hashText(
        JSON.stringify([stored.report.peonId, kind, requestId, "resume"])
      ),
      sender: options.sender,
      text: options.text,
      textHash:
        options.text === undefined ? undefined : yield* hashText(options.text),
    };

    const sleeping =
      stored.report.state === "suspended" ||
      stored.report.state === "hibernated";

    const next =
      kind === "prompt" && sleeping ? stored : yield* move(stored, event);

    const checkpoint = kind === "destroy" ? stored : next;

    yield* commit({ ...checkpoint, pending });

    return options.defer === true ? checkpoint.report : yield* recover;
  });

  return {
    command: begin,
    idle: Effect.fn("Peon.idle")(function* idle() {
      const stored = yield* requirePeon;

      if (stored.pending !== null) {
        return yield* recover;
      }

      const now = yield* Clock.currentTimeMillis;

      const at = peonIdleAlarm(
        stored.report.state,
        stored.idleAt,
        stored.report.resolvedTemplate
      );

      if (at !== null && at <= now) {
        return yield* stored.report.state === "idle"
          ? begin("suspend", `idle/${stored.idleAt}/suspend`, "IDLE_TIMEOUT")
          : begin("hibernate", `idle/${stored.idleAt}/hibernate`, "HIBERNATE");
      }

      yield* publish(indexOf(stored.report));
      yield* commit(stored);

      return stored.report;
    }),
    initialize: Effect.fn("Peon.initialize")(function* initialize(
      entry: typeof PeonIndexEntry.Type,
      template: typeof PeonTemplate.Type,
      cloned: boolean
    ) {
      const existing = yield* storage.load;

      if (existing !== undefined) {
        if (existing.report.owner !== entry.owner) {
          return yield* failure(
            "Peon owner differs from its registry reservation; refusing to expose another caller's workspace. Use a fresh peonId with spawnPeon."
          );
        }

        return yield* recover;
      }

      yield* assertPeonSpawnable(template);
      const now = yield* Clock.currentTimeMillis;

      const initial: PeonStoredValue = {
        idleAt: now,
        pending: null,
        report: {
          ...entry,
          bytes: null,
          fault: null,
          lastTurn: null,
          resolvedTemplate: template,
          state: "spawned",
          usage: emptyPeonUsage,
        },
      };

      if (cloned) {
        const suspended = yield* move(initial, "CLONE");

        yield* commit(suspended);
        yield* publish(indexOf(suspended.report));

        return suspended.report;
      }

      const attaching = yield* move(initial, "SPAWN");
      const requestId = `spawn/${entry.peonId}`;

      const pending: typeof PeonPending.Type = {
        boxRequestId: yield* hashText(
          JSON.stringify([entry.peonId, "spawn", requestId, "main"])
        ),
        inputHash: yield* hashText(JSON.stringify({ kind: "spawn" })),
        kind: "spawn",
        requestId,
        resumeRequestId: yield* hashText(
          JSON.stringify([entry.peonId, "spawn", requestId, "resume"])
        ),
      };

      yield* commit({ ...attaching, pending });

      return yield* recover;
    }),
    inspect: requirePeon.pipe(
      Effect.flatMap((stored) =>
        box.call(stored.report.peonId, "inspect", undefined, PeonBoxState).pipe(
          Effect.map(({ bytes }) => ({ ...reportWithPending(stored), bytes })),
          Effect.catchTag("PeonRefused", () =>
            Effect.succeed(reportWithPending(stored))
          )
        )
      )
    ),
    inspectStored: requirePeon.pipe(Effect.map(reportWithPending)),
  };
};
