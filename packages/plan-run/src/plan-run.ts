// @effect-diagnostics asyncFunction:off -- fetch, alarm and the alarm port are the Durable Object's Promise surface.
import { toHttpApi } from "@mischief/capability";
import { RunHost, RunStore, runCapabilities } from "@mischief/core";
import type { Judge, Mail, Operator, Thinker } from "@mischief/core";
import {
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
  readonly set: (at: number) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface PlanRunOptions {
  readonly storage: SqlStorage;
  readonly alarms: Alarms;
  readonly services: Layer.Layer<Thinker | Judge | Mail | Operator>;
  readonly guardMs: number;
  readonly now: () => number;
}

export interface PlanRun {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly alarm: () => Promise<void>;
}

const http = toHttpApi("Mischief", runCapabilities);

const isText = Schema.is(Schema.String);

const decodeStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ status: Schema.String }))
);

const anyRunning = (storage: SqlStorage) =>
  storage.sql
    .exec("SELECT state FROM mischief_runs")
    .toArray()
    .some((row) =>
      Option.exists(
        decodeStatus(row.state),
        ({ status }) => status === "running"
      )
    );

const runIdsOf = (storage: SqlStorage) =>
  storage.sql
    .exec("SELECT run_id FROM mischief_runs ORDER BY run_id")
    .toArray()
    .flatMap((row) => (isText(row.run_id) ? [row.run_id] : []));

export const makePlanRun = ({
  alarms,
  guardMs,
  now,
  services,
  storage,
}: PlanRunOptions): PlanRun => {
  const host = RunHost.layer.pipe(
    Layer.provideMerge(Layer.effect(RunStore, runStoreSql(storage))),
    Layer.provide(Layer.merge(services, webCrypto))
  );

  const memoMap = Layer.makeMemoMapUnsafe();
  const runtime = ManagedRuntime.make(host, { memoMap });
  const lock = Semaphore.makeUnsafe(1);

  const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.promise(async () => {
      await alarms.set(now() + guardMs);
    }).pipe(
      Effect.andThen(effect),
      Effect.ensuring(
        Effect.promise(async () => {
          if (!anyRunning(storage)) {
            await alarms.clear();
          }
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
            Effect.forEach(
              runIdsOf(storage),
              (runId) => runs.advance(runId).pipe(Effect.ignore),
              { discard: true }
            )
          )
        )
      );
    },
    fetch: async (request) => await handler(request),
  };
};
