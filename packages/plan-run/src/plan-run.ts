// @effect-diagnostics asyncFunction:off -- fetch, alarm and the alarm port are the Durable Object's Promise surface.
import { toHttpApi } from "@mischief/capability/http-api";
import { aroundHandlers } from "@mischief/capability/implement";
import {
  Drive,
  ProviderResume,
  overloadHeld,
  RunHost,
  RunStateSchema,
  RunStore,
  providerWakeAt,
  runCapabilities,
} from "@mischief/core";
import type {
  DriveLease,
  Judge,
  Mail,
  Operator,
  Thinker,
} from "@mischief/core";
import {
  Clock,
  Crypto,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
  Schedule,
  Semaphore,
} from "effect";
import { constVoid } from "effect/Function";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { DriveLeaseLost } from "./drive-lease-lost.js";
import { driveLease } from "./drive-lease.js";
import { runStoreSql } from "./sql-store.js";
import type { SqlStorage } from "./sql.js";
import { webCrypto } from "./web-crypto.js";

export interface Alarms {
  readonly get: () => Promise<number | null>;
  readonly set: (at: number) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface PlanRunOptions {
  readonly storage: SqlStorage;
  readonly alarms: Alarms;
  readonly services: Layer.Layer<Thinker | Judge | Mail | Operator>;
  readonly guardMs: number;
}

export interface PlanRun {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly alarm: (signal?: AbortSignal) => Promise<void>;
}

const isText = Schema.is(Schema.String);

const decodeState = Schema.decodeUnknownOption(
  Schema.fromJsonString(RunStateSchema)
);

const runsOf = (storage: SqlStorage) =>
  storage.sql
    .exec(
      "SELECT run_id, state FROM mischief_runs WHERE run_id NOT IN (SELECT run_id FROM mischief_paused WHERE paused = 1) ORDER BY run_id"
    )
    .toArray()
    .flatMap((row) => {
      const state = decodeState(row.state);

      return isText(row.run_id) && Option.isSome(state)
        ? [{ runId: row.run_id, state: state.value }]
        : [];
    });

const decodeSubmit = Schema.decodeUnknownOption(
  Schema.Struct({ runId: Schema.String })
);

const stored = (storage: SqlStorage, runId: string) =>
  storage.sql
    .exec("SELECT 1 FROM mischief_runs WHERE run_id = ?", runId)
    .toArray().length > 0;

const alarmPending = (storage: SqlStorage, runId: string) =>
  storage.sql
    .exec(
      "SELECT 1 FROM mischief_journal WHERE run_id = ? AND key = ?",
      runId,
      "done:hold-alarm"
    )
    .toArray().length === 0;

const wakeAt = (
  storage: SqlStorage,
  now: number,
  guardMs: number,
  attempts: number,
  runningAt: number
) => {
  const times = runsOf(storage).flatMap(({ runId, state }) => {
    if (state.status === "running") {
      return [runningAt];
    }

    if (
      state.status === "waiting-for-provider" &&
      state.resumeAttempts >= attempts
    ) {
      return state.held.some(overloadHeld) && alarmPending(storage, runId)
        ? [now + guardMs]
        : [];
    }

    const resume =
      state.status === "waiting-for-provider"
        ? providerWakeAt(state.held)
        : null;

    return resume === null ? [] : [resume];
  });

  return times.length === 0 ? null : Math.min(...times);
};

export const makePlanRun = ({
  alarms,
  guardMs,
  services,
  storage,
}: PlanRunOptions): PlanRun => {
  const lease = driveLease(storage);

  const wake = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.promise(async () => {
        await alarms.set(now);
      })
    )
  );

  const host = Layer.effect(
    RunHost,
    Effect.gen(function* readHost() {
      const reads = yield* RunHost.make;

      return {
        ...reads,
        inspect: (runId: string) =>
          reads
            .inspect(runId)
            .pipe(
              Effect.map((report) => ({ ...report, driveLease: lease.peek() }))
            ),
      };
    })
  ).pipe(
    Layer.provideMerge(Layer.effect(RunStore, runStoreSql(storage))),
    Layer.provideMerge(
      Layer.mergeAll(services, webCrypto, Drive.scheduled(wake))
    )
  );

  const memoMap = Layer.makeMemoMapUnsafe();
  const runtime = ManagedRuntime.make(host, { memoMap });
  const requests = Semaphore.makeUnsafe(1);
  let driving: AbortController | undefined;
  const interval = Math.max(1, Math.floor(guardMs / 3));

  const writerHost = (token: DriveLease) =>
    Effect.promise(
      async () =>
        await runtime.runPromise(
          RunHost.make.pipe(
            Effect.provideServiceEffect(
              RunStore,
              runStoreSql(lease.fenced(token))
            )
          )
        )
    );

  const armGuard = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.promise(async () => {
        const pending = await alarms.get();

        if (pending === null || pending <= now || pending > now + guardMs) {
          await alarms.set(now + guardMs);
        }
      })
    )
  );

  const reconcile = (immediate: boolean) =>
    Effect.gen(function* nextAlarm() {
      const now = yield* Clock.currentTimeMillis;
      const policy = yield* ProviderResume;

      yield* Effect.promise(async () => {
        const pending = await alarms.get();
        const holder = lease.peek();

        const next =
          holder.holder !== null && holder.leaseUntil > now
            ? holder.leaseUntil
            : wakeAt(
                storage,
                now,
                guardMs,
                policy.attempts,
                immediate ? now : now + guardMs
              );

        if (next === null) {
          await alarms.clear();
        } else if (next !== pending) {
          await alarms.set(next);
        }
      });
    });

  const exclusive = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    wait: boolean,
    acquired: () => void = constVoid
  ) =>
    Effect.gen(function* leasedWrite() {
      yield* armGuard;

      const holder = yield* Crypto.Crypto.use(
        (crypto) => crypto.randomUUIDv4
      ).pipe(Effect.provide(webCrypto), Effect.orDie);

      const take = Clock.currentTimeMillis.pipe(
        Effect.map((now) => lease.take(holder, now, guardMs))
      );

      const held = yield* wait
        ? take.pipe(
            Effect.repeat({
              schedule: Schedule.spaced(interval),
              while: Option.isNone,
            })
          )
        : take;

      if (Option.isNone(held)) {
        return Option.none<A>();
      }

      return yield* Effect.acquireUseRelease(
        Effect.succeed(held.value),
        (token) =>
          Effect.gen(function* holdingLease() {
            acquired();

            const keepAlive = Effect.sleep(interval).pipe(
              Effect.andThen(Clock.currentTimeMillis),
              Effect.flatMap((now) =>
                Effect.sync(() => lease.renew(token, now, guardMs))
              ),
              Effect.flatMap((renewed) =>
                renewed
                  ? Effect.void
                  : Effect.die(
                      new DriveLeaseLost({
                        owner: holder,
                        reason: `Drive epoch ${token.epoch} expired or was replaced. Work stopped; the alarm's next holder continues from the committed checkpoint. Poll inspectRun to see driveLease and progress.`,
                      })
                    )
              ),
              Effect.forever
            );

            return yield* Effect.raceFirst(
              effect.pipe(
                Effect.provideServiceEffect(RunHost, writerHost(token))
              ),
              keepAlive
            ).pipe(Effect.asSome);
          }),
        (token) =>
          Effect.sync(() => {
            lease.release(token);
          })
      );
    });

  const mutate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    exclusive(effect, true).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.die(
              new Error(
                "The writer wait ended without a lease; retry the capability and inspectRun."
              )
            ),
          onSome: Effect.succeed,
        })
      ),
      requests.withPermits(1),
      Effect.ensuring(reconcile(true))
    );

  const http = toHttpApi(
    "Mischief",
    aroundHandlers(runCapabilities, (contract, input, effect) =>
      contract.annotations.readOnly ||
      (contract.name === "submitPlan" &&
        Option.exists(decodeSubmit(input), ({ runId }) =>
          stored(storage, runId)
        ))
        ? effect
        : mutate(effect)
    )
  );

  const { handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(http.api).pipe(
      Layer.provide(http.layer),
      Layer.provide(Layer.merge(host, HttpServer.layerServices))
    ),
    { disableLogger: true, memoMap }
  );

  return {
    alarm: async (signal) => {
      const controller = new AbortController();

      const abort = () => {
        controller.abort();
      };

      signal?.addEventListener("abort", abort, { once: true });

      if (signal?.aborted === true) {
        controller.abort();
      }

      try {
        await runtime.runPromise(
          exclusive(
            RunHost.use((runs) =>
              Effect.gen(function* wakeRuns() {
                const now = yield* Clock.currentTimeMillis;
                const policy = yield* ProviderResume;

                yield* Effect.forEach(
                  runsOf(storage).filter(
                    ({ runId, state }) =>
                      state.status === "running" ||
                      (state.status === "waiting-for-provider" &&
                        ((state.resumeAttempts < policy.attempts &&
                          state.held.some(
                            ({ resumeAfter }) =>
                              resumeAfter !== null && resumeAfter <= now
                          )) ||
                          (state.resumeAttempts >= policy.attempts &&
                            state.held.some(overloadHeld) &&
                            alarmPending(storage, runId))))
                  ),
                  ({ runId }) => runs.advance(runId).pipe(Effect.ignore),
                  { discard: true }
                );
              })
            ),
            false,
            () => {
              driving?.abort();
              driving = controller;
            }
          ).pipe(Effect.ensuring(reconcile(false)), Effect.asVoid),
          { signal: controller.signal }
        );
      } finally {
        signal?.removeEventListener("abort", abort);

        if (driving === controller) {
          driving = undefined;
        }
      }
    },
    fetch: async (request) => await handler(request),
  };
};
