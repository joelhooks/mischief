import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { branchLength } from "../../src/plans/compile.js";
import type { Branch } from "../../src/plans/schema.js";
import { validatePlan } from "../../src/plans/validate.js";
import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";

const NAMES = ["s0", "s1", "s2", "s3"] as const;

const Target = Schema.Literals([...NAMES, "end", "nowhere"]);

const GraphSchema = Schema.Array(
  Schema.Array(Target).check(Schema.isMinLength(1), Schema.isMaxLength(3))
).check(Schema.isMinLength(4), Schema.isMaxLength(4));

const branchOf = (graph: readonly (readonly string[])[]): Branch => ({
  initial: "s0",
  states: {
    end: { type: "final" },
    ...Object.fromEntries(
      NAMES.map((name, index) => [
        name,
        {
          meta: { step: { kind: "think", prompt: name } },
          on: Object.fromEntries(
            (graph[index] ?? []).map((target, option) => [
              `e${option}`,
              { target },
            ])
          ),
        },
      ])
    ),
  },
});

const grow = (
  set: ReadonlySet<string>,
  step: (current: ReadonlySet<string>) => readonly string[],
  rounds: number
): ReadonlySet<string> =>
  rounds === 0 ? set : grow(new Set([...set, ...step(set)]), step, rounds - 1);

const modelSound = (graph: readonly (readonly string[])[]) => {
  const edges = new Map<string, readonly string[]>(
    NAMES.map((name, index) => [name, graph[index] ?? []])
  );

  const reaches = grow(
    new Set(["end"]),
    (current) =>
      NAMES.filter((name) =>
        (edges.get(name) ?? []).some((target) => current.has(target))
      ),
    NAMES.length
  );

  const reachable = grow(
    new Set(["s0"]),
    (current) => [...current].flatMap((name) => [...(edges.get(name) ?? [])]),
    NAMES.length
  );

  return [...reachable].every(
    (name) => name !== "nowhere" && reaches.has(name)
  );
};

const modelLongest = (graph: readonly (readonly string[])[]) => {
  const edges = new Map<string, readonly string[]>(
    NAMES.map((name, index) => [name, graph[index] ?? []])
  );

  const sequences = (prefix: readonly string[]): (readonly string[])[] => [
    prefix,
    ...NAMES.filter((name) => !prefix.includes(name)).flatMap((name) =>
      sequences([...prefix, name])
    ),
  ];

  return Math.max(
    ...sequences(["s0"])
      .filter((path) =>
        path.every(
          (name, index) =>
            index === 0 ||
            (edges.get(path[index - 1] ?? "") ?? []).includes(name)
        )
      )
      .filter((path) => (edges.get(path.at(-1) ?? "") ?? []).includes("end"))
      .map((path) => path.length)
  );
};

it.prop(
  "a branch's length is its longest loop-free path to a final state, and only sound branches have one",
  { graph: Arbitrary.schema(GraphSchema) },
  ({ graph }) => {
    expect(branchLength(branchOf(graph))).toBe(
      modelSound(graph) ? modelLongest(graph) : undefined
    );
  },
  { arbitrary: { runs: 500 } }
);

const Verdict = Schema.Literals(["pass", "fail", "unsure"]);

const ScriptSchema = Schema.Array(Verdict).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4)
);

const BRANCHES = ["a", "b"] as const;

const gated = (name: string) => ({
  initial: "build",
  states: {
    build: {
      meta: { step: { kind: "think", prompt: `build ${name}` } },
      on: { done: { target: "verify" } },
    },
    done: { type: "final" },
    verify: {
      meta: { step: { kind: "judge", question: `is ${name} right?` } },
      on: { fail: { target: "build" }, pass: { target: "done" } },
    },
  },
});

const planOf = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 10,
    maxDepth: 3,
    maxSteps: 100,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "two packets, gated each",
  id: "gates",
  machine: {
    id: "gates",
    initial: "fan",
    states: {
      end: { type: "final" },
      fan: {
        meta: {
          step: {
            branches: Object.fromEntries(
              BRANCHES.map((name) => [name, gated(name)])
            ),
            join: "allSettled",
            kind: "parallel",
          },
        },
        on: { done: { target: "end" } },
      },
    },
  },
};

const branchOfKey = (key: string) => (key.includes(".a.") ? "a" : "b");

it.effect.prop(
  "each branch's gate loops on its own verdicts, and one branch asking Joel never holds up the other",
  {
    scripts: Arbitrary.schema(
      Schema.Struct({ a: ScriptSchema, b: ScriptSchema })
    ),
  },
  ({ scripts }) =>
    Effect.gen(function* property() {
      const builds = { a: 0, b: 0 };
      const verdicts = { a: 0, b: 0 };

      const verdictAt = (branch: "a" | "b", index: number) =>
        scripts[branch][index] ?? "pass";

      const settledAt = (branch: "a" | "b") => {
        const at = scripts[branch].findIndex((verdict) => verdict !== "fail");

        return at === -1 ? scripts[branch].length : at;
      };

      const host = yield* RunHost.make.pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(
          Thinker,
          Thinker.of({
            decide: () => Effect.die("unused"),
            elaborate: () => Effect.die("unused"),
            think: ({ key }) => {
              builds[branchOfKey(key)] += 1;

              return Effect.succeed({ output: "built", tokens: 1 });
            },
          })
        ),
        Effect.provideService(
          Judge,
          Judge.of({
            choose: ({ key }) => {
              const branch = branchOfKey(key);
              const verdict = verdictAt(branch, verdicts[branch]);

              verdicts[branch] += 1;

              return Effect.succeed({
                probabilities:
                  verdict === "unsure"
                    ? { fail: 0.5, pass: 0.5 }
                    : {
                        fail: verdict === "fail" ? 0.9 : 0.1,
                        pass: verdict === "pass" ? 0.9 : 0.1,
                      },
                usage: { tokens: 1 },
              });
            },
          })
        ),
        Effect.provideService(
          Mail,
          Mail.of({
            seal: () => Effect.die("unused"),
            send: () => Effect.die("unused"),
          })
        ),
        Effect.provideService(
          Operator,
          Operator.of({ notify: () => Effect.void })
        )
      );

      let report = yield* host.submit("run", planOf);

      for (
        let turn = 0;
        report.status === "waiting-for-joel" && turn < 4;
        turn += 1
      ) {
        const waiting = branchOfKey(report.question?.key ?? "");
        const other = waiting === "a" ? "b" : "a";

        expect({ other, verdicts: verdicts[other] }).toEqual({
          other,
          verdicts: settledAt(other) + 1,
        });

        report = yield* host.answer("run", "pass");
      }

      expect(report.status).toBe("done");
      expect(builds).toEqual({ a: settledAt("a") + 1, b: settledAt("b") + 1 });
    }).pipe(Effect.provide(RunStore.memory)),
  { arbitrary: { runs: 60 } }
);

it.effect.prop(
  "a judge in a branch needs two options and a fallback that names one of them",
  {
    fallback: Arbitrary.schema(
      Schema.UndefinedOr(Schema.Literals(["pass", "fail", "maybe"]))
    ),
    options: Arbitrary.schema(Schema.Literals([1, 2])),
  },
  ({ fallback, options }) =>
    Effect.gen(function* property() {
      const verify = {
        meta: {
          step:
            fallback === undefined
              ? { kind: "judge", question: "right?" }
              : { fallback, kind: "judge", question: "right?" },
        },
        on:
          options === 2
            ? { fail: { target: "build" }, pass: { target: "done" } }
            : { pass: { target: "done" } },
      };

      const branch = {
        ...gated("a"),
        states: { ...gated("a").states, verify },
      };

      const plan = {
        ...planOf,
        machine: {
          ...planOf.machine,
          states: {
            ...planOf.machine.states,
            fan: {
              ...planOf.machine.states.fan,
              meta: {
                step: {
                  ...planOf.machine.states.fan.meta.step,
                  branches: { a: branch, b: gated("b") },
                },
              },
            },
          },
        },
        version: 1,
      };

      const exit = yield* Effect.exit(validatePlan(plan));
      const text = String(Exit.isFailure(exit) && exit.cause);

      const badFallback =
        fallback !== undefined &&
        !(options === 2 ? ["pass", "fail"] : ["pass"]).includes(fallback);

      expect(Exit.isSuccess(exit)).toBe(options === 2 && !badFallback);
      expect(
        text.includes("fan.a.verify: judge needs at least two transitions")
      ).toBe(options === 1);
      expect(text.includes("fan.a.verify: fallback")).toBe(badFallback);
    }),
  { arbitrary: { runs: 40 } }
);
