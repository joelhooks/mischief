import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import { Judge, whyDocName } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";

const WHY = whyDocName("check");

const TEMPLATE = `Is the sky usually blue on a clear day? Earlier reason: {{docs.${WHY}}}`;

const checkPlan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Escalate a templated question",
  id: "check",
  machine: {
    id: "check",
    initial: "check",
    states: {
      check: {
        meta: {
          step: {
            kind: "judge",
            question: TEMPLATE,
            reads: [WHY],
            threshold: 0.99,
          },
        },
        on: { failed: { target: "failed" }, passed: { target: "passed" } },
      },
      failed: { type: "final" },
      passed: { type: "final" },
    },
  },
};

const Line = Schema.String.check(Schema.isPattern(/^[a-z][a-z ]{0,30}$/u));

const WorldSchema = Schema.Struct({
  fresh: Line,
  seeded: Line,
});

it.effect.prop(
  "an escalated judge mails, reports and re-announces the question the judge saw, rendered from the docs at that visit, never the raw template or a doc the verdict rewrote, including after a revision",
  { world: Arbitrary.schema(WorldSchema) },
  ({ world }) =>
    Effect.gen(function* rendered() {
      const seen: string[] = [];
      const mailed: string[] = [];

      const judge = Layer.succeed(
        Judge,
        Judge.of({
          choose: ({ question }) =>
            Effect.sync(() => {
              seen.push(question);

              return {
                probabilities: { failed: 0.7, passed: 0.3 },
                usage: { tokens: 351 },
                why: [`fresh ${world.fresh}`],
              };
            }),
        })
      );

      const hostOn = RunHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            judge,
            Thinker.unwired,
            Mail.unwired,
            Layer.succeed(
              Operator,
              Operator.of({
                notify: (_runId, { question }) =>
                  Effect.sync(() => {
                    mailed.push(question);
                  }),
              })
            )
          )
        )
      );

      const expected = TEMPLATE.replace(
        `{{docs.${WHY}}}`,
        `seeded ${world.seeded}`
      );

      const runs = yield* hostOn;

      const submitted = yield* runs.submit("ask", checkPlan, {
        [WHY]: `seeded ${world.seeded}`,
      });

      expect(submitted.status).toBe("waiting-for-joel");
      expect(seen, "the judge sees the rendered question").toStrictEqual([
        expected,
      ]);
      expect(submitted.question?.question).toBe(expected);

      const store = yield* RunStore;
      const docs = yield* store.readDocs("ask");

      expect(
        docs[WHY],
        "the verdict rewrote the doc the question reads"
      ).toStrictEqual([`fresh ${world.fresh}`]);

      const restarted = yield* hostOn;
      const again = yield* restarted.advance("ask");

      expect(again.question?.question).toBe(expected);

      yield* restarted.revise(
        "ask",
        { ...checkPlan, goal: "Escalate the same question again" },
        false
      );

      const revised = yield* restarted.inspect("ask");

      expect(revised.status).toBe("waiting-for-joel");
      expect(
        revised.question?.question,
        "after a revision the escalation shows what the judge saw at that visit"
      ).toBe(seen.at(-1));
      expect(revised.question?.question).not.toContain("{{docs.");
      expect(
        mailed,
        "every escalation mail carries the question the judge saw"
      ).not.toHaveLength(0);

      expect(
        mailed,
        "each escalation mail carries what its judge saw"
      ).toStrictEqual(seen.slice(0, mailed.length));
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 60 } }
);
