import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { StepFailed } from "../../src/steps/step-failed.js";
import { Thinker } from "../../src/steps/thinker.js";

const DESKS = ["desk/engine", "desk/wire", "desk/content"] as const;

const lane = (to: string) => ({
  initial: "land",
  states: {
    done: { type: "final" },
    land: {
      meta: {
        step: {
          kind: "ask",
          message: `land for ${to}`,
          to,
          writes: to.replace("desk/", ""),
        },
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
    maxSteps: 20,
    maxThinking: "low",
    models: ["sol"],
    names: [...DESKS],
    thresholds: { judge: 0.8 },
  },
  goal: "Ask three desks at once",
  id: "board",
  machine: {
    id: "board",
    initial: "build",
    states: {
      build: {
        meta: {
          step: {
            branches: Object.fromEntries(
              DESKS.map((to) => [to.replace("desk/", ""), lane(to)])
            ),
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

const SendSchema = Schema.Literals(["ok", "refused", "crash"]);

const WorldSchema = Schema.Struct({
  sends: Schema.Array(SendSchema).check(Schema.isMaxLength(8)),
  supersededBy: Schema.UndefinedOr(Schema.Literal("board-v2")),
});

it.effect.prop(
  "aborting a run mails each open ask exactly one closing note naming the ask and any successor, sealed once and resent as the same bytes after a crash",
  { world: Arbitrary.schema(WorldSchema) },
  ({ world }) =>
    Effect.gen(function* closeOnce() {
      const seals: { readonly message: string; readonly to: string }[] = [];
      const delivered = new Map<string, Set<string>>();
      const script = { sends: [...world.sends] };

      const mail = Layer.succeed(
        Mail,
        Mail.of({
          seal: ({ key, message, to }) =>
            Effect.sync(() => {
              seals.push({ message, to });

              return {
                envelope: `${to}|${key}|nonce-${seals.length}`,
                messageId: key.startsWith("close:")
                  ? `close-${seals.length}`
                  : `ask-${to}`,
              };
            }),
          send: ({ key }, { envelope }) =>
            Effect.suspend(() => {
              if (!key.startsWith("close:")) {
                return Effect.void;
              }

              const [next, ...rest] = script.sends;

              script.sends = rest;

              if (next === "crash") {
                return Effect.die("celld restarted mid-abort");
              }

              if (next === "refused") {
                return Effect.fail(
                  new StepFailed({ key, reason: "mailbox refused" })
                );
              }

              const own = delivered.get(key) ?? new Set<string>();

              delivered.set(key, own.add(envelope));

              return Effect.void;
            }),
        })
      );

      const runs = yield* RunHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Judge.unwired,
            Thinker.unwired,
            mail,
            Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
          )
        )
      );

      const submitted = yield* runs.submit("board", boardPlan);

      expect(submitted.awaiting?.map(({ to }) => to).toSorted()).toStrictEqual(
        [...DESKS].toSorted()
      );

      const asks = submitted.awaiting?.map(({ messageId }) => messageId) ?? [];

      let report = yield* Effect.exit(runs.abort("board", world.supersededBy));

      for (let tries = 0; Exit.isFailure(report) && tries < 10; tries += 1) {
        report = yield* Effect.exit(runs.abort("board", world.supersededBy));
      }

      expect(Exit.isSuccess(report) ? report.value.status : "crashed").toBe(
        "aborted"
      );

      const closes = seals.filter(({ message }) =>
        message.startsWith("Closed:")
      );

      expect(
        closes.map(({ to }) => to).toSorted(),
        "each open ask is sealed one closing note, once, however often the abort crashed"
      ).toStrictEqual([...DESKS].toSorted());

      for (const { message } of closes) {
        expect(
          asks.some((ask) => message.includes(`"supersedes":"${ask}"`))
        ).toBe(true);
        expect(message.includes("board-v2")).toBe(
          world.supersededBy !== undefined
        );
      }

      for (const [key, envelopes] of delivered) {
        expect(
          envelopes.size,
          `${key} reached the mailbox as different bytes`
        ).toBe(1);
      }
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 80 } }
);
