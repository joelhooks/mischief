// @effect-diagnostics asyncFunction:off -- fetch, alarm and the alarm port are the Durable Object's Promise surface.
import { toHttpApi } from "@mischief/capability/http-api";
import {
  runCapabilities,
  ScheduleAlarm,
  ScheduleStore,
  scheduleCapabilities,
  thinkingCapabilities,
  WakeRuns,
  wakeSchedule,
} from "@mischief/core";
import { Effect, Layer, ManagedRuntime, Semaphore } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder, OpenApi } from "effect/http-api";

import type { Alarms } from "./plan-run.js";
import { scheduleStoreSql } from "./schedule-store.js";
import type { SqlStorage } from "./sql.js";

export interface ScheduleOptions {
  readonly storage: SqlStorage;
  readonly alarms: Alarms;
  readonly runs: WakeRuns["Service"];
}

export interface ScheduleObject {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly alarm: () => Promise<void>;
}

const http = toHttpApi("Mischief schedules", scheduleCapabilities);

export const mischiefApiSpec = () =>
  OpenApi.fromApi(
    toHttpApi("Mischief", [
      ...runCapabilities,
      ...scheduleCapabilities,
      ...thinkingCapabilities,
    ]).api
  );

export const makeSchedule = ({
  alarms,
  runs,
  storage,
}: ScheduleOptions): ScheduleObject => {
  const services = Layer.mergeAll(
    Layer.succeed(ScheduleStore, scheduleStoreSql(storage)),
    Layer.succeed(WakeRuns, runs),
    Layer.succeed(
      ScheduleAlarm,
      ScheduleAlarm.of({
        set: (at) =>
          Effect.promise(async () => {
            await (at === null ? alarms.clear() : alarms.set(at));
          }),
      })
    )
  );

  const memoMap = Layer.makeMemoMapUnsafe();
  const runtime = ManagedRuntime.make(services, { memoMap });
  const lock = Semaphore.makeUnsafe(1);

  const { handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(http.api).pipe(
      Layer.provide(http.layer),
      Layer.provide(Layer.merge(services, HttpServer.layerServices))
    ),
    {
      disableLogger: true,
      memoMap,
      middleware: (effect) => lock.withPermits(1)(effect),
    }
  );

  return {
    alarm: async () => {
      await runtime.runPromise(lock.withPermits(1)(wakeSchedule()));
    },
    fetch: async (request) => await handler(request),
  };
};
