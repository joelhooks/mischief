// @effect-diagnostics asyncFunction:off -- alarm() is the Durable Object's Promise surface.
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Judge, Mail, Operator, Thinker } from "@mischief/core";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Random,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { nodeSqlStorage } from "../src/node-sql.js";
import { mailOutboxSql } from "../src/outbox.js";
import { makePlanRun } from "../src/plan-run.js";
import type { SqlStorage } from "../src/sql.js";
import { alarmsFor, callAndDrive as call, decodeReport } from "./support.js";
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
    services: Layer.mergeAll(
      thinker,
      Judge.unwired,
      mailOutboxSql(storage),
      Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
    ),
    storage,
  });

it.live.prop(
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

      const victim = yield* Effect.forkChild(
        call(first, "submitPlan", { plan: chainOf(length), runId: "line" })
      );

      yield* Deferred.await(hung);

      expect(log.pending).not.toBeNull();

      yield* Fiber.interrupt(victim);

      const after: World = { answered: before.answered, thoughts: [] };

      const second = runOn(
        nodeSqlStorage(file),
        log,
        thinkerFor(after, null, hung)
      );

      if (inspectFirst) {
        const armed = log.pending;

        yield* Effect.sleep("5 millis");

        const seen = decodeReport(
          (yield* call(second, "inspectRun", { runId: "line" })).body
        );

        expect(seen.status).toBe("running");
        expect(log.pending).toBe(armed);
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
  { arbitrary: { runs: 40 }, timeout: 120_000 }
);

interface Mailbox {
  readonly admitted: Map<string, string>;
  conflicts: number;
  sends: number;
}

const askPlan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 1,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: ["desk/land"],
    thresholds: { judge: 0.8 },
  },
  goal: "Ask once, survive an eviction mid-send",
  id: "ask",
  machine: {
    id: "ask",
    initial: "ask",
    states: {
      ask: {
        meta: {
          step: {
            kind: "ask",
            message: "land it",
            to: "desk/land",
            writes: "reply",
          },
        },
        on: { replied: { target: "end" } },
      },
      end: { type: "final" },
    },
  },
};

const mailFor = (
  mailbox: Mailbox,
  die: "beforeAdmit" | "afterAdmit" | null,
  hung: Deferred.Deferred<number>
) =>
  Layer.succeed(
    Mail,
    Mail.of({
      seal: ({ key, runId, visit }) =>
        Random.next.pipe(
          Effect.map((nonce) => ({
            envelope: `${key} ${nonce}`,
            messageId: `${runId}/${key}#${visit}`,
          }))
        ),
      send: (_call, { envelope, messageId }) =>
        Effect.gen(function* send() {
          mailbox.sends += 1;

          if (die === "beforeAdmit") {
            yield* Deferred.succeed(hung, mailbox.sends);

            return yield* Effect.never;
          }

          const known = mailbox.admitted.get(messageId);

          if (known !== undefined && known !== envelope) {
            mailbox.conflicts += 1;
          }

          mailbox.admitted.set(messageId, envelope);

          if (die === "afterAdmit") {
            yield* Deferred.succeed(hung, mailbox.sends);

            return yield* Effect.never;
          }

          return yield* Effect.void;
        }),
    })
  );

const askRunOn = (
  storage: SqlStorage,
  log: AlarmLog,
  mail: Layer.Layer<Mail>
) =>
  makePlanRun({
    alarms: alarmsFor(log),
    guardMs: 30_000,
    services: Layer.mergeAll(
      Thinker.unwired,
      Judge.unwired,
      mail,
      Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
    ),
    storage,
  });

it.live.prop(
  "a run evicted mid-send is finished by its alarm, which resends the journaled envelope byte for byte, so the mailbox admits one message",
  { die: Arbitrary.schema(Schema.Literals(["beforeAdmit", "afterAdmit"])) },
  ({ die }) =>
    Effect.gen(function* property() {
      const fs = yield* FileSystem.FileSystem;

      const file = (yield* Path.Path).join(
        yield* fs.makeTempDirectoryScoped(),
        "run.sqlite"
      );

      const log: AlarmLog = { pending: null, sets: 0 };
      const mailbox: Mailbox = { admitted: new Map(), conflicts: 0, sends: 0 };
      const hung = yield* Deferred.make<number>();

      const first = askRunOn(
        nodeSqlStorage(file),
        log,
        mailFor(mailbox, die, hung)
      );

      const victim = yield* Effect.forkChild(
        call(first, "submitPlan", { plan: askPlan, runId: "asks" })
      );

      yield* Deferred.await(hung);

      expect(
        log.pending,
        "the alarm stays armed while a send is in flight"
      ).not.toBeNull();

      yield* Fiber.interrupt(victim);

      const stored = nodeSqlStorage(file)
        .sql.exec(
          "SELECT key FROM mischief_journal WHERE run_id = ? ORDER BY seq",
          "asks"
        )
        .toArray()
        .flatMap(({ key }) => (Schema.is(Schema.String)(key) ? [key] : []));

      expect(
        stored.filter(
          (key) => key.startsWith("directive:") || key.startsWith("done:")
        ),
        "what the crash left is today's on-disk shape: an Ask directive with no done"
      ).toEqual(["directive:asks:ask:1:0"]);

      const sentBefore = mailbox.sends;

      const second = askRunOn(
        nodeSqlStorage(file),
        log,
        mailFor(mailbox, null, hung)
      );

      yield* Effect.promise(async () => {
        await second.alarm();
      });

      expect(mailbox.sends - sentBefore, "the owed ask goes out once").toBe(1);

      yield* Effect.promise(async () => {
        await second.alarm();
      });

      expect(mailbox.sends - sentBefore, "and never again").toBe(1);

      const final = decodeReport(
        (yield* call(second, "inspectRun", { runId: "asks" })).body
      );

      expect(final.status).toBe("waiting-for-reply");
      expect(final.awaiting?.map(({ messageId }) => messageId)).toEqual([
        "asks/ask#1",
      ]);
      expect(mailbox.conflicts).toBe(0);
      expect([...mailbox.admitted.keys()]).toEqual(["asks/ask#1"]);
      expect(mailbox.sends).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 10 }, timeout: 120_000 }
);
