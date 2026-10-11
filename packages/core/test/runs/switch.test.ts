import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { validatePlan } from "../../src/plans/validate.js";
import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";

const OPTIONS = ["ship", "hold", "drop"] as const;

type Option = (typeof OPTIONS)[number];

const VALUES = ["green", "amber", "red", "blue"] as const;

const envelope = {
  maxAgents: 10,
  maxDepth: 3,
  maxSteps: 100,
  maxThinking: "low",
  models: ["sol"],
  names: [],
  thresholds: { judge: 0.8 },
};

const routes = (options: readonly string[]) =>
  Object.fromEntries(
    options.map((option) => [
      `take_${option}`,
      {
        meta: { step: { kind: "think", prompt: option, writes: "took" } },
        on: { done: { target: "end" } },
      },
    ])
  );

const switchOn = (
  cases: Readonly<Record<string, string>>,
  fallback: string,
  options: readonly string[]
) => ({
  meta: {
    step: { cases, default: fallback, kind: "switch", reads: "light" },
  },
  on: Object.fromEntries(
    options.map((option) => [option, { target: `take_${option}` }])
  ),
});

const linePlan = (
  prompt: string,
  cases: Readonly<Record<string, string>>,
  fallback: string,
  inBranch: boolean
) => {
  const states = {
    end: { type: "final" },
    gate: switchOn(cases, fallback, OPTIONS),
    light: {
      meta: { step: { kind: "think", prompt, writes: "light" } },
      on: { done: { target: "gate" } },
    },
    ...routes(OPTIONS),
  };

  const other = {
    initial: "idle",
    states: {
      end: { type: "final" },
      idle: {
        meta: { step: { kind: "think", prompt: "idle", writes: "idle" } },
        on: { done: { target: "end" } },
      },
    },
  };

  return {
    defaults: { agent: {} },
    envelope,
    goal: "route on a light",
    id: "lights",
    machine: {
      id: "lights",
      initial: inBranch ? "fan" : "light",
      states: inBranch
        ? {
            end: { type: "final" },
            fan: {
              meta: {
                step: {
                  branches: { lane: { initial: "light", states }, other },
                  join: "allSettled",
                  kind: "parallel",
                },
              },
              on: { done: { target: "end" } },
            },
          }
        : states,
    },
  };
};

const services = Layer.mergeAll(
  NodeCrypto.layer,
  RunStore.memory,
  Layer.succeed(
    Thinker,
    Thinker.of({
      decide: () => Effect.die("unused"),
      elaborate: () => Effect.die("unused"),
      think: ({ prompt }) => Effect.succeed({ output: prompt, tokens: 1 }),
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
  Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
);

const CasesSchema = Schema.Record(
  Schema.Literals(VALUES),
  Schema.Literals(OPTIONS)
);

const expectedRoute = (
  value: string,
  cases: Readonly<Record<string, Option>>,
  fallback: Option
) => (Object.hasOwn(cases, value.trim()) ? cases[value.trim()] : fallback);

it.effect.prop(
  "a switch takes the case its doc's trimmed text names, else its default, at the top level and in a branch",
  {
    cases: Arbitrary.schema(CasesSchema),
    fallback: Arbitrary.schema(Schema.Literals(OPTIONS)),
    inBranch: Arbitrary.schema(Schema.Boolean),
    pad: Arbitrary.schema(Schema.Literals(["", " ", "\n", "  \n"])),
    value: Arbitrary.schema(Schema.Literals(VALUES)),
  },
  ({ cases, fallback, inBranch, pad, value }) =>
    Effect.gen(function* property() {
      const host = yield* RunHost.make;

      const report = yield* host.submit(
        "run",
        linePlan(`${pad}${value}${pad}`, cases, fallback, inBranch)
      );

      expect(report.status).toBe("done");
      expect(report.docs.took).toBe(expectedRoute(value, cases, fallback));

      const journal = yield* (yield* RunStore).readJournal("run");
      const entry = [...journal].find(([key]) => key.includes(".gate#"))?.[1];

      expect(entry).toEqual({
        choice: expectedRoute(value, cases, fallback),
        defaulted: !Object.hasOwn(cases, value),
        tokens: 0,
        value,
      });
    }).pipe(Effect.provide(services)),
  { arbitrary: { runs: 120 } }
);

it.effect.prop(
  "a switch is refused when a case or its default is not a declared transition, or it reads a doc nothing writes",
  {
    cases: Arbitrary.schema(CasesSchema),
    declared: Arbitrary.schema(Schema.Array(Schema.Literals(OPTIONS))),
    fallback: Arbitrary.schema(Schema.Literals(OPTIONS)),
    reads: Arbitrary.schema(Schema.Literals(["light", "nothing"])),
  },
  ({ cases, declared, fallback, reads }) =>
    Effect.gen(function* property() {
      const plan = linePlan("green", cases, fallback, false);
      const gate = switchOn(cases, fallback, declared);

      const revised = {
        ...plan,
        machine: {
          ...plan.machine,
          states: {
            ...plan.machine.states,
            gate: {
              ...gate,
              meta: { step: { ...gate.meta.step, reads } },
            },
          },
        },
        version: 1,
      };

      const exit = yield* Effect.exit(validatePlan(revised));
      const text = String(Exit.isFailure(exit) && exit.cause);

      const badCases = Object.entries(cases).filter(
        ([, option]) => !declared.includes(option)
      );

      const badDefault = !declared.includes(fallback);
      const badReads = reads === "nothing";

      expect(Exit.isSuccess(exit)).toBe(
        badCases.length === 0 && !badDefault && !badReads
      );

      for (const [value, option] of badCases) {
        expect(text).toContain(
          `gate: switch case "${value}" goes to "${option}"`
        );
      }

      expect(text.includes(`gate: switch default "${fallback}"`)).toBe(
        badDefault
      );
      expect(text.includes(`gate: doc "nothing" is not written`)).toBe(
        badReads
      );
    }),
  { arbitrary: { runs: 120 } }
);

it.effect(
  "a switch on a doc no step has written yet fails with what to change, and the run ends failed",
  () =>
    Effect.gen(function* failing() {
      const host = yield* RunHost.make;
      const plan = linePlan("green", { green: "ship" }, "hold", false);

      const early = {
        ...plan,
        machine: { ...plan.machine, initial: "gate" },
      };

      const report = yield* host.submit("run", early);

      expect(report.status).toBe("failed");
      expect(report.docs["failed:gate"]).toBe(true);
    }).pipe(Effect.provide(services))
);

it.effect.prop(
  "a revision reruns a switch when its doc changed and takes the new route, and reuses it otherwise",
  {
    after: Arbitrary.schema(Schema.Literals(VALUES)),
    before: Arbitrary.schema(Schema.Literals(VALUES)),
    cases: Arbitrary.schema(CasesSchema),
    fallback: Arbitrary.schema(Schema.Literals(OPTIONS)),
  },
  ({ after, before, cases, fallback }) =>
    Effect.gen(function* property() {
      const host = yield* RunHost.make;

      yield* host.submit("run", linePlan(before, cases, fallback, false));

      const revised = yield* host.revise(
        "run",
        linePlan(after, cases, fallback, false),
        false
      );

      const switched = revised.live.some((key) => key.includes(".gate#"));
      const route = expectedRoute(after, cases, fallback);

      expect(revised.run.status).toBe("done");
      expect(revised.run.docs.took).toBe(route);
      expect(switched).toBe(before !== after);
      expect(Object.keys(revised.run.docs).toSorted()).toEqual(
        ["light", "took"].toSorted()
      );
    }).pipe(Effect.provide(services)),
  { arbitrary: { runs: 80 } }
);
