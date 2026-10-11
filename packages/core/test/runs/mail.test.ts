import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Random,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunHost } from "../../src/runs/host.js";
import { ReplyRefused } from "../../src/runs/reply-refused.js";
import { RunStore } from "../../src/runs/run-store.js";
import type { ReplyLine, RunReport } from "../../src/runs/schema.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import type { Sealed } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { StepFailed } from "../../src/steps/step-failed.js";
import { Thinker } from "../../src/steps/thinker.js";

const RUN = "board";

const BRANCHES = ["engine", "wire", "content"] as const;

const ASKS = [
  ...BRANCHES.map((branch) => ({
    key: `build.${branch}.land`,
    to: `desk/${branch}`,
    writes: branch,
  })),
  { key: "budget", to: "desk/joel", writes: "budget" },
] as const;

type AskKey = (typeof ASKS)[number]["key"];

const branch = (name: string, to: string) => ({
  initial: "land",
  states: {
    done: { type: "final" },
    land: {
      meta: {
        step: { kind: "ask", message: `land ${name}`, to, writes: name },
      },
      on: { replied: { target: "done" } },
    },
  },
});

const boardPlan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 40,
    maxThinking: "low",
    models: ["sol"],
    names: ASKS.map(({ to }) => to),
    thresholds: { judge: 0.8 },
  },
  goal: "Coordinate three desks, then ask about the budget",
  id: "board",
  machine: {
    id: "board",
    initial: "build",
    states: {
      budget: {
        meta: {
          step: {
            kind: "ask",
            message: "budgetUsd?",
            to: "desk/joel",
            writes: "budget",
          },
        },
        on: { replied: { target: "end" } },
      },
      build: {
        meta: {
          step: {
            branches: Object.fromEntries(
              BRANCHES.map((name) => [name, branch(name, `desk/${name}`)])
            ),
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: { done: { target: "budget" } },
      },
      end: { type: "final" },
    },
  },
};

const CrashSchema = Schema.Struct({
  nth: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })),
  point: Schema.Literals(["sealed", "admitted", "saved"]),
});

type Crash = typeof CrashSchema.Type;

const WorldArbitrary = Arbitrary.all({
  crashes: Arbitrary.array(Arbitrary.schema(CrashSchema), { maxLength: 3 }),
  duplicates: Arbitrary.array(Arbitrary.schema(Schema.Boolean), {
    maxLength: 4,
    minLength: 4,
  }),
  impostor: Arbitrary.schema(Schema.Boolean),
  order: Arbitrary.schema(Schema.Literals([0, 1, 2, 3, 4, 5])),
  paused: Arbitrary.array(Arbitrary.schema(Schema.Boolean), {
    maxLength: 4,
    minLength: 4,
  }),
});

const PERMUTATIONS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

interface Server {
  readonly admitted: Map<string, string>;
  conflicts: number;
}

interface Armed {
  readonly crashes: Crash[];
  readonly seen: Record<Crash["point"], number>;
}

const fire = (armed: Armed, point: Crash["point"]) => {
  armed.seen[point] += 1;

  const index = armed.crashes.findIndex(
    (crash) => crash.point === point && crash.nth === armed.seen[point]
  );

  if (index === -1) {
    return false;
  }

  armed.crashes.splice(index, 1);

  return true;
};

const lineFor = (
  messageId: string,
  from: string,
  body = `reply from ${from}`
): ReplyLine => ({
  acceptedAt: "2026-10-11T00:00:00Z",
  body,
  from,
  messageId: `reply:${messageId}`,
  replyTo: messageId,
});

const unused = Layer.mergeAll(Judge.unwired, Thinker.unwired);

const oneProcess = <A, E>(
  base: (typeof RunStore)["Service"],
  server: Server,
  armed: Armed,
  op: (host: (typeof RunHost)["Service"]) => Effect.Effect<A, E>
) =>
  Effect.gen(function* process() {
    const victim = yield* Deferred.make<Fiber.Fiber<A, E>>();
    const state = { dead: false };

    const die = Effect.gen(function* dieNow() {
      state.dead = true;
      const fiber = yield* Deferred.await(victim);
      yield* Effect.forkDetach(Fiber.interrupt(fiber));

      return yield* Effect.never;
    });

    const alive = <B, F>(effect: Effect.Effect<B, F>) =>
      Effect.suspend(() => (state.dead ? Effect.never : effect));

    const store = RunStore.of({
      ...base,
      writeDoc: (runId, name, doc) => alive(base.writeDoc(runId, name, doc)),
      writeJournal: (runId, key, entry) =>
        alive(base.writeJournal(runId, key, entry)),
      writeMessage: (messageId, runId) =>
        Effect.suspend(() =>
          fire(armed, "sealed")
            ? die
            : alive(base.writeMessage(messageId, runId))
        ),
      writePlan: (runId, plan) => alive(base.writePlan(runId, plan)),
      writeRun: (runId, saved) =>
        alive(base.writeRun(runId, saved)).pipe(
          Effect.andThen(() => (fire(armed, "saved") ? die : Effect.void))
        ),
    });

    const admit = (key: string, sealed: Sealed) =>
      Effect.suspend(() => {
        const known = server.admitted.get(sealed.messageId);

        if (known !== undefined && known !== sealed.envelope) {
          server.conflicts += 1;

          return Effect.fail(new StepFailed({ key, reason: "409 Conflict" }));
        }

        server.admitted.set(sealed.messageId, sealed.envelope);

        return fire(armed, "admitted") ? die : Effect.void;
      });

    const mail = Mail.of({
      seal: ({ key, runId, visit }) =>
        Random.next.pipe(
          Effect.map((nonce) => ({
            envelope: `${key} ${nonce}`,
            messageId: `${runId}/${key}#${visit}`,
          }))
        ),
      send: ({ key }, sealed) => alive(admit(key, sealed)),
    });

    const host = yield* RunHost.make.pipe(
      Effect.provide(Layer.merge(NodeCrypto.layer, unused)),
      Effect.provideService(RunStore, store),
      Effect.provideService(Mail, mail),
      Effect.provideService(
        Operator,
        Operator.of({ notify: () => Effect.void })
      )
    );

    const fiber = yield* Effect.forkChild(op(host));
    yield* Deferred.succeed(victim, fiber);
    const exit = yield* Effect.exit(Fiber.join(fiber));

    return state.dead ? Option.none() : Option.some(exit);
  });

const awaitedKeys = (report: RunReport) =>
  (report.awaiting ?? []).map(({ key }) => key).toSorted();

it.effect.prop(
  "replies in any order, with crashes, duplicates and impostors, finish the board with one message per ask",
  { world: WorldArbitrary },
  ({ world }) =>
    Effect.gen(function* property() {
      const base = yield* RunStore;
      const server: Server = { admitted: new Map(), conflicts: 0 };

      const armed: Armed = {
        crashes: [...world.crashes],
        seen: { admitted: 0, saved: 0, sealed: 0 },
      };

      const settled = <A, E>(
        op: (host: (typeof RunHost)["Service"]) => Effect.Effect<A, E>
      ) =>
        Effect.gen(function* untilSettled() {
          let crashed = false;

          for (;;) {
            const recovered =
              !crashed ||
              Option.isSome(
                yield* oneProcess(base, server, armed, (host) =>
                  host.resume(RUN)
                )
              );

            const outcome = recovered
              ? yield* oneProcess(base, server, armed, op)
              : Option.none();

            if (Option.isSome(outcome)) {
              return { crashed, exit: outcome.value };
            }

            crashed = true;
          }
        });

      const inspect = Effect.gen(function* inspectNow() {
        const { exit } = yield* settled((host) => host.inspect(RUN));

        return yield* exit;
      });

      yield* settled((host) => host.submit(RUN, boardPlan));

      let waiting: AskKey[] = BRANCHES.map(
        (name) => `build.${name}.land` as const
      );

      const order = [...PERMUTATIONS[world.order], 3].flatMap((index) => {
        const ask = ASKS[index];

        return ask === undefined ? [] : [ask];
      });

      for (const [index, ask] of order.entries()) {
        const before = yield* inspect;

        expect(before.status).toBe("waiting-for-reply");
        expect(awaitedKeys(before)).toEqual(waiting.toSorted());

        const open = (before.awaiting ?? []).find(({ key }) => key === ask.key);
        const messageId = open?.messageId ?? "";

        if (world.impostor) {
          const { from: _verified, ...unsigned } = lineFor(messageId, ask.to);

          for (const line of [lineFor(messageId, "desk/impostor"), unsigned]) {
            const { exit } = yield* settled((host) => host.deliver(line));

            expect(Exit.isFailure(exit)).toBe(true);
          }
        }

        if (world.paused[index] === true) {
          yield* settled((host) => host.pause(RUN));

          const held = yield* settled((host) =>
            host.deliver(lineFor(messageId, ask.to))
          );

          expect(
            held.crashed ||
              (Exit.isSuccess(held.exit) && held.exit.value.status === "paused")
          ).toBe(true);
        }

        const { crashed, exit } = yield* settled((host) =>
          world.paused[index] === true
            ? host.resume(RUN).pipe(Effect.orDie)
            : host.deliver(lineFor(messageId, ask.to))
        );

        expect(Exit.isSuccess(exit) || crashed).toBe(true);

        if (world.duplicates[index] === true) {
          const again = yield* settled((host) =>
            host.deliver(lineFor(messageId, ask.to))
          );

          expect(
            Exit.isFailure(again.exit) &&
              Schema.is(ReplyRefused)(
                Option.getOrUndefined(Exit.findErrorOption(again.exit))
              )
          ).toBe(true);
        }

        waiting = waiting.filter((key) => key !== ask.key);

        if (waiting.length === 0 && ask.key !== "budget") {
          waiting = ["budget"];
        }
      }

      const final = yield* inspect;

      expect(final.status).toBe("done");
      expect(
        Object.fromEntries(
          ASKS.map(({ writes }) => [writes, final.docs[writes]])
        )
      ).toEqual(
        Object.fromEntries(
          ASKS.map(({ to, writes }) => [writes, `reply from ${to}`])
        )
      );
      expect(server.conflicts).toBe(0);
      expect([...server.admitted.keys()].toSorted()).toEqual(
        ASKS.map(({ key }) => `${RUN}/${key}#1`).toSorted()
      );
    }).pipe(Effect.provide(RunStore.memory)),
  { arbitrary: { runs: 300 }, timeout: 20_000 }
);
