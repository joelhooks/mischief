// @effect-diagnostics asyncFunction:off -- alarm() is the Durable Object's Promise surface.
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Judge, Operator, Thinker } from "@mischief/core";
import { Deferred, Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { nodeSqlStorage } from "../src/node-sql.js";
import { mailOutboxSql } from "../src/outbox.js";
import { makePlanRun } from "../src/plan-run.js";
import type { SqlStorage } from "../src/sql.js";
import { alarmsFor, call, decodeReport } from "./support.js";
import type { AlarmLog } from "./support.js";

const STEPS = ["one", "two", "three", "four"] as const;

const chainOf = (length: number) => {
  const names = STEPS.slice(0, length);

  return {
    defaults: { agent: {} },
    envelope: {
      maxAgents: 4,
      maxDepth: 3,
      maxSteps: 40,
      maxThinking: "low",
      models: ["sol"],
      names: [],
      thresholds: { judge: 0.8 },
    },
    goal: "Think in a line, survive an eviction",
    id: "line",
    machine: {
      id: "line",
      initial: "one",
      states: {
        ...Object.fromEntries(
          names.map((name, index) => [
            name,
            {
              meta: { step: { kind: "think", prompt: name, writes: name } },
              on: { done: { target: names[index + 1] ?? "end" } },
            },
          ])
        ),
        end: { type: "final" },
      },
    },
  };
};

interface World {
  readonly answered: Map<string, string>;
  readonly thoughts: string[];
}

const thinkerFor = (
  world: World,
  hangAt: number | null,
  hung: Deferred.Deferred<number>
) => {
  let calls = 0;

  return Layer.succeed(
    Thinker,
    Thinker.of({
      decide: () => Effect.die("unused"),
      elaborate: () => Effect.die("unused"),
      think: ({ epoch, key, prompt, visit }) =>
        Effect.gen(function* think() {
          calls += 1;

          if (calls === hangAt) {
            yield* Deferred.succeed(hung, calls);

            return yield* Effect.never;
          }

          const address = `${key}#${visit}@${epoch}`;
          const output = world.answered.get(address) ?? `${prompt} thought`;

          world.thoughts.push(prompt);
          world.answered.set(address, output);

          return { output, tokens: 1 };
        }),
    })
  );
};

const runOn = (
  storage: SqlStorage,
  log: AlarmLog,
  thinker: Layer.Layer<Thinker>
) =>
  makePlanRun({
    alarms: alarmsFor(log),
    guardMs: 30_000,
    now: () => 0,
    services: Layer.mergeAll(
      thinker,
      Judge.unwired,
      mailOutboxSql(storage),
      Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
    ),
    storage,
  });

it.effect.prop(
  "a run evicted mid-think is finished by its alarm, even when a request arrives first, and only the unfinished think runs again",
  {
    crashAt: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 }))
    ),
    inspectFirst: Arbitrary.schema(Schema.Boolean),
    length: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 2 }))
    ),
  },
  ({ crashAt, inspectFirst, length }) =>
    Effect.gen(function* property() {
      const hangAt = Math.min(crashAt, length);
      const fs = yield* FileSystem.FileSystem;

      const file = (yield* Path.Path).join(
        yield* fs.makeTempDirectoryScoped(),
        "run.sqlite"
      );

      const log: AlarmLog = { pending: null, sets: 0 };
      const before: World = { answered: new Map(), thoughts: [] };
      const hung = yield* Deferred.make<number>();

      const first = runOn(
        nodeSqlStorage(file),
        log,
        thinkerFor(before, hangAt, hung)
      );

      yield* Effect.forkDetach(
        call(first, "submitPlan", { plan: chainOf(length), runId: "line" })
      );
      yield* Deferred.await(hung);

      expect(log.pending).not.toBeNull();

      const after: World = { answered: before.answered, thoughts: [] };

      const second = runOn(
        nodeSqlStorage(file),
        log,
        thinkerFor(after, null, hung)
      );

      if (inspectFirst) {
        const seen = decodeReport(
          (yield* call(second, "inspectRun", { runId: "line" })).body
        );

        expect(seen.status).toBe("running");
        expect(log.pending).not.toBeNull();
      }

      yield* Effect.promise(async () => {
        await second.alarm();
      });

      const final = decodeReport(
        (yield* call(second, "inspectRun", { runId: "line" })).body
      );

      expect(final.status).toBe("done");

      for (const name of STEPS.slice(0, length)) {
        expect(final.docs[name]).toBe(`${name} thought`);
      }

      expect(after.thoughts).toEqual(STEPS.slice(hangAt - 1, length));
      expect(log.pending).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 40 } }
);
