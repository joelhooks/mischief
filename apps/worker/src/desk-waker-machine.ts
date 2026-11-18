import { watchActor } from "@mischief/capability/actor-watch";
import type {
  DeskInspection,
  DeskLease,
  DeskWakeResult,
} from "@mischief/core/desk-wake";
import {
  createEffectActor,
  createEffectLogic,
  setupEffect,
  waitFor,
} from "@xstate/effect";
import { Clock, Context, Effect, Match, Random } from "effect";
import { types } from "xstate";
import type { SnapshotFrom } from "xstate";

export type DeskState = typeof DeskInspection.Type;

type WakeResult = typeof DeskWakeResult.Type;

export class DeskHost extends Context.Service<
  DeskHost,
  {
    readonly wake: (
      name: string,
      messageId: string
    ) => Effect.Effect<WakeResult>;
    readonly leaseLive: (
      name: string
    ) => Effect.Effect<typeof DeskLease.Type | null>;
  }
>()("@mischief/worker/DeskHost") {}

interface Turn {
  readonly name: string;
  readonly state: DeskState;
  readonly messageId: string | undefined;
  readonly now: number;
}

interface Input {
  readonly name: string;
  readonly messageId: string | null;
}

interface WakerContext {
  readonly turn: Turn;
  readonly data: Omit<DeskState, "state">;
}

const MINUTE = 60_000;

export const LEASE_INTERVAL = 5 * MINUTE;

const backoff = [5 * MINUTE, 20 * MINUTE, 60 * MINUTE];

export const asleep: DeskState = {
  alarmAt: null,
  attempts: 0,
  messageId: null,
  pending: null,
  ready: null,
  reason: "",
  state: "asleep",
};

const nextLeaseCheck = Effect.all([
  Clock.currentTimeMillis,
  Random.nextBetween(0, 30_000),
]).pipe(
  Effect.map(([now, jitter]) => now + LEASE_INTERVAL + Math.floor(jitter))
);

const restore = createEffectLogic({
  effect: ({ input }) =>
    DeskHost.use(({ wake }) =>
      Effect.gen(function* restoreDesk() {
        if (input.messageId === null) {
          return yield* Effect.die(
            new Error("DeskWaker has no admitted messageId to restore")
          );
        }

        const result = yield* wake(input.name, input.messageId);
        const now = yield* Clock.currentTimeMillis;

        const checkAt =
          result.result === "restored" ? yield* nextLeaseCheck : null;

        return { ...result, checkAt, now };
      })
    ),
  schemas: { input: types<Input>() },
});

const checkLease = createEffectLogic({
  effect: ({ input }) =>
    DeskHost.use(({ leaseLive }) =>
      Effect.gen(function* checkDesk() {
        const lease = yield* leaseLive(input);
        const now = yield* Clock.currentTimeMillis;
        const checkAt = yield* nextLeaseCheck;

        return { checkAt, lease, now };
      })
    ),
  schemas: { input: types<string>() },
});

export const deskAlarmAt = ({ alarmAt, pending }: DeskState) => {
  if (pending === null) {
    return alarmAt;
  }

  return alarmAt === null
    ? pending.probeAt
    : Math.min(alarmAt, pending.probeAt);
};

const queued = (messageId: string, now: number) => ({
  alarmAt: now,
  attempts: 0,
  messageId,
  pending: null,
  ready: null,
  reason: "",
});

interface LeaseCheck {
  readonly checkAt: number;
  readonly lease: typeof DeskLease.Type | null;
  readonly now: number;
}

const checked = (
  data: WakerContext["data"],
  { checkAt, lease, now }: LeaseCheck
) => {
  const { pending } = data;

  const alarmAt =
    data.alarmAt !== null && data.alarmAt > now ? data.alarmAt : checkAt;

  if (lease === null) {
    return {
      context: {
        data: {
          ...data,
          alarmAt,
          pending: pending === null ? null : { ...pending, probeAt: alarmAt },
        },
      },
      target: "waiting",
    } as const;
  }

  if ("permanent" in lease) {
    return {
      context: {
        data: {
          ...data,
          alarmAt: null,
          attempts: pending === null ? data.attempts : 1,
          messageId: pending?.messageId ?? data.messageId,
          pending: null,
          ready: pending === null ? data.ready : null,
          reason: lease.reason,
        },
      },
      target: "#desk.wake-failed",
    } as const;
  }

  if (lease.live) {
    return {
      context: { data: { ...data, alarmAt, pending: null } },
      target: "waiting",
    } as const;
  }

  if (pending !== null) {
    return {
      context: { data: queued(pending.messageId, now) },
      target: "#desk.waking.queued",
    } as const;
  }

  return {
    context: { data: { ...data, alarmAt: null } },
    target: "#desk.asleep",
  } as const;
};

const machine = setupEffect({
  actors: { checkLease, restore },
  schemas: { context: types<WakerContext>(), input: types<Turn>() },
}).createMachine({
  context: ({ input }) => ({ data: input.state, turn: input }),
  initial: "selecting",
  states: {
    asleep: {},
    backoff: {},
    reading: {
      initial: "waiting",
      states: {
        checking: {
          invoke: {
            input: ({ context }) => context.turn.name,
            onDone: ({ context, event }) => checked(context.data, event.output),
            src: "checkLease",
          },
        },
        waiting: {},
      },
    },
    selecting: {
      always: ({ context }) => {
        const { messageId, now, state } = context.turn;

        if (messageId !== undefined) {
          if (state.state === "asleep" || state.state === "wake-failed") {
            return {
              context: { data: queued(messageId, now) },
              target: "waking.queued",
            };
          }

          if (state.state === "reading") {
            return {
              context: {
                data: { ...context.data, pending: { messageId, probeAt: now } },
              },
              target: "reading.waiting",
            };
          }
        }

        const alarmAt = deskAlarmAt(state);

        if (messageId === undefined && alarmAt !== null && alarmAt <= now) {
          if (state.state === "waking" || state.state === "backoff") {
            return { target: "waking.restoring" };
          }

          if (state.state === "reading") {
            return { target: "reading.checking" };
          }
        }

        return { target: state.state };
      },
    },
    "wake-failed": {},
    waking: {
      initial: "queued",
      states: {
        queued: {},
        restoring: {
          invoke: {
            input: ({ context }) => ({
              messageId: context.data.messageId,
              name: context.turn.name,
            }),
            onDone: ({ context, event }) => {
              const {
                checkAt,
                inProgress,
                now,
                permanent,
                ready,
                reason,
                result,
              } = event.output;

              const { attempts, messageId } = context.data;
              const waiting = inProgress === true && result === "failed";
              let delay = permanent === true ? undefined : backoff[attempts];

              if (waiting) {
                delay = LEASE_INTERVAL;
              }

              const alarmAt =
                result === "failed" && delay !== undefined
                  ? now + delay
                  : checkAt;

              const target = Match.value(result).pipe(
                Match.withReturnType<
                  | "#desk.wake-failed"
                  | "#desk.backoff"
                  | "#desk.asleep"
                  | "#desk.reading"
                >(),
                Match.when("failed", () =>
                  delay === undefined ? "#desk.wake-failed" : "#desk.backoff"
                ),
                Match.when("lost", () => "#desk.asleep"),
                Match.when("restored", () => "#desk.reading"),
                Match.exhaustive
              );

              return {
                context: {
                  data: {
                    alarmAt,
                    attempts: waiting ? attempts : attempts + 1,
                    messageId,
                    pending: null,
                    ready: ready ?? null,
                    reason,
                  },
                },
                target,
              };
            },
            src: "restore",
          },
        },
      },
    },
  },
  id: "desk",
});

const stateOf = (
  snapshot: SnapshotFrom<typeof machine>
): DeskState["state"] => {
  if (snapshot.matches("reading")) {
    return "reading";
  }

  if (snapshot.matches("waking")) {
    return "waking";
  }

  if (snapshot.matches("backoff")) {
    return "backoff";
  }

  return snapshot.matches("wake-failed") ? "wake-failed" : "asleep";
};

export const deskTurn = Effect.fn("deskWakerTurn")(function* deskWakerTurn(
  input: Turn
) {
  const actor = yield* createEffectActor(machine, { input });
  yield* watchActor("deskWakerMachine", actor);

  const snapshot = yield* waitFor(
    actor,
    (current) =>
      !(
        current.matches("selecting") ||
        current.matches("waking.restoring") ||
        current.matches("reading.checking")
      )
  );

  return { ...snapshot.context.data, state: stateOf(snapshot) };
}, Effect.scoped);
