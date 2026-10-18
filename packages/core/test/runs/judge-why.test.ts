import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunStore } from "../../src/runs/run-store.js";
import {
  Judge,
  whyDocName,
  WHY_LINE_CHARS,
  WHY_LINES,
} from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { SHADOW_JUDGE, shadowJudge } from "../../src/steps/shadow-judge.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const checkPlan = (goal: string) => ({
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
  goal,
  id: "check",
  machine: {
    id: "check",
    initial: "check",
    states: {
      check: {
        meta: { step: { kind: "judge", question: "Does it hold?" } },
        on: { failed: { target: "failed" }, passed: { target: "passed" } },
      },
      failed: { type: "final" },
      passed: { type: "final" },
    },
  },
});

const hostWith = (judge: Layer.Layer<Judge>) =>
  RunHost.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        judge,
        Thinker.unwired,
        Mail.unwired,
        Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
      )
    )
  );

const host = hostWith(shadowJudge);

const VerdictSchema = Schema.Struct({
  answeredBy: Schema.Literals(["shadow", "jev"]),
  choice: Schema.Literals(["passed", "failed"]),
  why: Schema.UndefinedOr(
    Schema.Array(Schema.String.check(Schema.isMaxLength(WHY_LINE_CHARS))).check(
      Schema.isMaxLength(WHY_LINES)
    )
  ),
});

const WHY = whyDocName("check");

it.effect.prop(
  "a verdict's why lines become the judge's why doc; a revision restores it from Jev's journaled verdict without asking again, and from a fresh shadow verdict",
  { verdict: Arbitrary.schema(VerdictSchema) },
  ({ verdict }) =>
    Effect.gen(function* whyKept() {
      const calls = { count: 0 };

      const jev = Layer.succeed(
        Judge,
        Judge.of({
          choose: () =>
            Effect.sync(() => {
              calls.count += 1;

              const judgement = {
                probabilities: { [verdict.choice]: 1 },
                usage: { tokens: 0 },
              };

              return verdict.why === undefined
                ? judgement
                : { ...judgement, why: verdict.why };
            }),
        })
      );

      const runs = yield* verdict.answeredBy === "jev" ? hostWith(jev) : host;
      const store = yield* RunStore;
      const violations: string[] = [];

      const body =
        verdict.why === undefined
          ? { choice: verdict.choice }
          : { choice: verdict.choice, why: verdict.why };

      const submitted = yield* runs.submit("why", checkPlan("Check once"));

      const done =
        verdict.answeredBy === "jev"
          ? submitted
          : yield* runs.deliver({
              body: JSON.stringify(body),
              from: SHADOW_JUDGE,
              replyTo: "why/check#1",
            });

      if (done.value !== verdict.choice) {
        violations.push(
          `the verdict ${verdict.choice} ended at ${String(done.value)}`
        );
      }

      const live = (yield* store.readDocs("why"))[WHY];

      if (JSON.stringify(live) !== JSON.stringify(verdict.why)) {
        violations.push(
          `live ${WHY} is ${JSON.stringify(live)}, the verdict said ${JSON.stringify(verdict.why)}`
        );
      }

      const revised = yield* runs.revise(
        "why",
        checkPlan("Check once, revised"),
        false
      );

      if (
        verdict.answeredBy === "jev" &&
        (calls.count !== 1 ||
          !revised.reused.some((key) => key.includes("check")))
      ) {
        violations.push(
          `the revision should reuse Jev's journaled verdict, but Jev was called ${String(calls.count)} times and the revision reused ${JSON.stringify(revised.reused)}`
        );
      }

      if (
        verdict.answeredBy === "shadow" &&
        (revised.run.status !== "waiting-for-reply" ||
          WHY in (yield* store.readDocs("why")))
      ) {
        violations.push(
          `a revision discards shadow verdicts, so the run should wait for a fresh one with no ${WHY}, but it is ${revised.run.status}`
        );
      }

      if (verdict.answeredBy === "shadow") {
        yield* runs.deliver({
          body: JSON.stringify(body),
          from: SHADOW_JUDGE,
          replyTo: "why/check#1",
        });
      }

      const replayed = (yield* store.readDocs("why"))[WHY];

      if (JSON.stringify(replayed) !== JSON.stringify(live)) {
        violations.push(
          `after the revision ${WHY} is ${JSON.stringify(replayed)}, before it was ${JSON.stringify(live)}`
        );
      }

      expect(violations, violations.join("\n")).toStrictEqual([]);
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 40 } }
);

it.effect(
  "a why longer than the bounds fails the step and states the bounds",
  () =>
    Effect.gen(function* tooLong() {
      const runs = yield* host;

      yield* runs.submit("long", checkPlan("Check once"));

      const refused = yield* runs.deliver({
        body: JSON.stringify({
          choice: "failed",
          why: Array.from(
            { length: WHY_LINES + 1 },
            (_, n) => `line ${String(n)}`
          ),
        }),
        from: SHADOW_JUDGE,
        replyTo: "long/check#1",
      });

      expect(refused.docs["failed:check"]).toBe(true);
      expect(refused.docs[WHY]).toBeUndefined();

      const journal = yield* RunStore.use((store) => store.readJournal("long"));

      expect(JSON.stringify([...journal.values()])).toContain(
        `up to ${String(WHY_LINES)} lines of at most ${String(WHY_LINE_CHARS)} characters`
      );
    }).pipe(Effect.provide(RunStore.memory))
);
