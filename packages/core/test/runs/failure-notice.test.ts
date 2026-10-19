import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunStore, withinRun } from "../../src/runs/run-store.js";
import type { StepFailure } from "../../src/runs/schema.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { StepFailed } from "../../src/steps/step-failed.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const plan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 2,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "announce a failure once",
  id: "notice",
  machine: {
    id: "notice",
    initial: "draft",
    states: {
      draft: {
        meta: { step: { kind: "think", prompt: "draft", writes: "draft" } },
        on: { done: { target: "end" } },
      },
      end: { type: "final" },
    },
  },
};

const servicesFor = (
  fails: boolean,
  announced: { runId: string; failures: readonly StepFailure[] }[]
) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    RunStore.memory,
    Layer.succeed(
      Thinker,
      Thinker.of({
        decide: () => Effect.die("unused"),
        elaborate: () => Effect.die("unused"),
        think: ({ key, prompt }) =>
          fails
            ? Effect.fail(new StepFailed({ key, reason: "the proxy refused" }))
            : Effect.succeed({ output: prompt, tokens: 1 }),
      })
    ),
    Layer.succeed(Judge, Judge.of({ choose: () => Effect.die("unused") })),
    Layer.succeed(
      Mail,
      Mail.of({
        seal: () => Effect.die("unused"),
        send: () => Effect.die("unused"),
      })
    ),
    Layer.succeed(
      Operator,
      Operator.of({
        failed: (runId, failures) =>
          Effect.sync(() => {
            announced.push({ failures, runId });
          }),
        notify: () => Effect.void,
      })
    )
  );

it.effect.prop(
  "a failed run tells its operator once, with every failure, however often it is driven again, and a run that finishes never does",
  {
    drives: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 0 }))
    ),
    fails: Arbitrary.schema(Schema.Boolean),
  },
  ({ drives, fails }) => {
    const announced: { runId: string; failures: readonly StepFailure[] }[] = [];

    return Effect.gen(function* property() {
      const host = yield* RunHost.make;

      const first = yield* host.submit("run", plan);

      for (let drive = 0; drive < drives; drive += 1) {
        yield* host.advance("run");
      }

      expect(first.status).toBe(fails ? "failed" : "done");

      expect(announced).toEqual(
        fails ? [{ failures: first.failures ?? [], runId: "run" }] : []
      );

      if (fails) {
        expect(announced[0]?.failures).toHaveLength(1);
      }

      const store = yield* RunStore;
      const state = yield* store.readRun("run");
      const stored = yield* store.readPlan("run", 1);

      if (Option.isSome(state) && Option.isSome(stored)) {
        yield* withinRun(
          store,
          "older"
        )(
          Effect.all([
            store.writePlan("older", stored.value),
            store.writeRun("older", state.value),
          ])
        );
      }

      for (let drive = 0; drive <= drives; drive += 1) {
        yield* host.advance("older");
      }

      expect(
        announced.filter(({ runId }) => runId === "older"),
        "a run that failed before notices existed never mails when driven again"
      ).toEqual([]);
    }).pipe(Effect.provide(servicesFor(fails, announced)));
  },
  { arbitrary: { runs: 40 } }
);
