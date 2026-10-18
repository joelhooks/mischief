// @effect-diagnostics asyncFunction:off -- fetch, alarm and the alarm port are the Durable Object's Promise surface.
import { toHttpApi } from "@mischief/capability/http-api";
import {
  ProviderResume,
  overloadHeld,
  RunHost,
  RunStateSchema,
  RunStore,
  providerWakeAt,
  runCapabilities,
} from "@mischief/core";
import type { Judge, Mail, Operator, Thinker } from "@mischief/core";
import {
  Clock,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
  Semaphore,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

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
  readonly alarm: () => Promise<void>;
}

const http = toHttpApi("Mischief", runCapabilities);

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
  pending: number | null
) => {
  const times = runsOf(storage).flatMap(({ runId, state }) => {
    if (state.status === "running") {
      return [Math.min(pending ?? now + guardMs, now + guardMs)];
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
  const host = RunHost.layer.pipe(
    Layer.provideMerge(Layer.effect(RunStore, runStoreSql(storage))),
    Layer.provideMerge(Layer.merge(services, webCrypto))
  );

  const memoMap = Layer.makeMemoMapUnsafe();
  const runtime = ManagedRuntime.make(host, { memoMap });
  const lock = Semaphore.makeUnsafe(1);

  const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Effect.promise(async () => {
          const pending = await alarms.get();

          if (pending === null || pending > now + guardMs) {
            await alarms.set(now + guardMs);
          }
        })
      ),
      Effect.andThen(effect),
      Effect.ensuring(
        Effect.gen(function* nextAlarm() {
          const now = yield* Clock.currentTimeMillis;
          const policy = yield* ProviderResume;

          yield* Effect.promise(async () => {
            const pending = await alarms.get();

            const next = wakeAt(
              storage,
              now,
              guardMs,
              policy.attempts,
              pending
            );

            if (next === null) {
              await alarms.clear();
            } else if (next !== pending) {
              await alarms.set(next);
            }
          });
        })
      ),
      lock.withPermits(1)
    );

  const { handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(http.api).pipe(
      Layer.provide(http.layer),
      Layer.provide(Layer.merge(host, HttpServer.layerServices))
    ),
    { disableLogger: true, memoMap, middleware: guarded }
  );

  return {
    alarm: async () => {
      await runtime.runPromise(
        guarded(
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
          )
        )
      );
    },
    fetch: async (request) => await handler(request),
  };
};
