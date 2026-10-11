import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Judge, Mail, Operator, Thinker } from "@mischief/core";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { nodeSqlStorage } from "../src/node-sql.js";
import { mailOutboxSql } from "../src/outbox.js";
import { makePlanRun } from "../src/plan-run.js";
import type { SqlStorage } from "../src/sql.js";
import { alarmsFor, call, decodeReport } from "./support.js";
import type { AlarmLog } from "./support.js";

const BRANCHES = ["alpha", "beta", "gamma"] as const;

const branch = (name: string) => ({
  initial: "land",
  states: {
    done: { type: "final" },
    land: {
      meta: {
        step: {
          kind: "ask",
          message: `land ${name}`,
          to: `desk/${name}`,
          writes: name,
        },
      },
      on: { replied: { target: "settle" } },
    },
    settle: {
      meta: {
        step: {
          kind: "think",
          prompt: `settle ${name}`,
          writes: `${name}_settled`,
        },
      },
      on: { done: { target: "done" } },
    },
  },
});

const plan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 3,
    maxDepth: 3,
    maxSteps: 40,
    maxThinking: "low",
    models: ["sol"],
    names: BRANCHES.map((name) => `desk/${name}`),
    thresholds: { judge: 0.8 },
  },
  goal: "Hear from three desks at once",
  id: "fan",
  machine: {
    id: "fan",
    initial: "build",
    states: {
      build: {
        meta: {
          step: {
            branches: {
              alpha: branch("alpha"),
              beta: branch("beta"),
              gamma: branch("gamma"),
            },
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: { done: { target: "end" } },
      },
      end: { type: "final" },
    },
  },
};

interface Tally {
  readonly thoughts: Map<string, number>;
  readonly sends: Map<string, number>;
}

const bump = (counts: Map<string, number>, key: string) => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

const slowThinker = (delays: readonly number[], tally: Tally) => {
  const answered = new Map<string, string>();
  let calls = 0;

  return Layer.succeed(
    Thinker,
    Thinker.of({
      decide: () => Effect.die("unused"),
      elaborate: () => Effect.die("unused"),
      think: ({ epoch, key, prompt, visit }) =>
        Effect.gen(function* slowThink() {
          calls += 1;
          yield* Effect.sleep(delays[calls % delays.length] ?? 0);

          const address = `${key}#${visit}@${epoch}`;

          bump(tally.thoughts, address);

          const output = answered.get(address) ?? `${prompt} done`;

          answered.set(address, output);

          return { output, tokens: 1 };
        }),
    })
  );
};

const countedMail = (storage: SqlStorage, tally: Tally) =>
  Layer.effect(
    Mail,
    Effect.gen(function* countSends() {
      const outbox = yield* Mail;

      return Mail.of({
        seal: outbox.seal,
        send: (step, sealed) =>
          Effect.sync(() => {
            bump(tally.sends, sealed.messageId);
          }).pipe(Effect.andThen(outbox.send(step, sealed))),
      });
    })
  ).pipe(Layer.provide(mailOutboxSql(storage)));

const planRunOn = (
  storage: SqlStorage,
  log: AlarmLog,
  delays: readonly number[],
  tally: Tally
) =>
  makePlanRun({
    alarms: alarmsFor(log),
    guardMs: 30_000,
    services: Layer.mergeAll(
      slowThinker(delays, tally),
      Judge.unwired,
      countedMail(storage, tally),
      Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
    ),
    storage,
  });

it.effect.prop(
  "replies delivered to one run all at once are each taken exactly once, and no ask or think runs twice, in any order, with duplicates",
  {
    delays: Arbitrary.schema(
      Schema.Array(
        Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 0 }))
      ).check(Schema.isMinLength(1), Schema.isMaxLength(4))
    ),
    order: Arbitrary.schema(
      Schema.Array(Schema.Literals(BRANCHES)).check(
        Schema.isMinLength(3),
        Schema.isMaxLength(7)
      )
    ),
  },
  ({ delays, order }) =>
    Effect.gen(function* property() {
      const fs = yield* FileSystem.FileSystem;

      const file = (yield* Path.Path).join(
        yield* fs.makeTempDirectoryScoped(),
        "run.sqlite"
      );

      const storage = nodeSqlStorage(file);
      const log: AlarmLog = { pending: null, sets: 0 };
      const tally: Tally = { sends: new Map(), thoughts: new Map() };

      const run = planRunOn(storage, log, delays, tally);

      const submitted = decodeReport(
        (yield* call(run, "submitPlan", { plan, runId: "fan" })).body
      );

      expect(submitted.status).toBe("waiting-for-reply");

      const ids = new Map(
        (submitted.awaiting ?? []).map(({ messageId }) => [
          BRANCHES.find((name) => messageId.includes(`.${name}.`)) ?? "",
          messageId,
        ])
      );

      const deliveries = [...BRANCHES, ...order].map((name) =>
        call(run, "deliverReply", {
          body: `${name} landed`,
          from: `desk/${name}`,
          replyTo: ids.get(name) ?? "",
        })
      );

      yield* Effect.all(deliveries, { concurrency: "unbounded" });

      const final = decodeReport(
        (yield* call(run, "inspectRun", { runId: "fan" })).body
      );

      expect(final.status).toBe("done");

      for (const name of BRANCHES) {
        expect(final.docs[name]).toBe(`${name} landed`);
        expect(final.docs[`${name}_settled`]).toBe(`settle ${name} done`);
      }

      expect(
        storage.sql
          .exec("SELECT COUNT(*) AS sent FROM mischief_outbox")
          .toArray()[0]?.sent
      ).toBe(BRANCHES.length);
      expect([...tally.sends.values()]).toEqual(BRANCHES.map(() => 1));
      expect([...tally.thoughts.values()]).toEqual(BRANCHES.map(() => 1));
      expect(log.pending).toBeNull();
      expect(log.sets).toBe(2 + BRANCHES.length + order.length);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 40 }, timeout: 120_000 }
);
