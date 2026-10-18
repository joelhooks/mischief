import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { validatePlan } from "../../src/plans/validate.js";
import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "../runs/inline-host.js";

const POOL = ["alpha", "beta", "gamma"] as const;

const isText = Schema.is(Schema.String);

const asText = (doc: string | number) =>
  isText(doc) ? doc : JSON.stringify(doc);

const Names = Schema.Array(Schema.Literals(POOL)).check(Schema.isMaxLength(3));

const DESK = "desk/x";

const template = (refs: readonly string[]) =>
  `use ${refs.map((name) => `{{docs.${name}}}`).join(" and ")} now`;

const envelope = {
  maxAgents: 10,
  maxDepth: 3,
  maxSteps: 30,
  maxThinking: "low",
  models: ["sol"],
  names: [DESK],
  thresholds: { judge: 0.8 },
};

const refStep = (kind: "ask" | "think", text: string, writes: string) =>
  kind === "think"
    ? { kind, prompt: text, writes }
    : { kind, message: text, to: DESK, writes };

const chain = (
  writers: readonly string[],
  last: Schema.Json,
  lastName: string
): Schema.Json => {
  const names = [...writers.map((name) => `w_${name}`), lastName, "end"];

  const entries: [string, Schema.Json][] = [
    ...writers.map((name, index): [string, Schema.Json] => [
      `w_${name}`,
      {
        meta: {
          step: { kind: "think", prompt: `write ${name}`, writes: name },
        },
        on: { done: { target: names[index + 1] ?? "end" } },
      },
    ]),
    [lastName, last],
    ["end", { type: "final" }],
  ];

  return Object.fromEntries(entries);
};

const planWith = (
  writers: readonly string[],
  kind: "ask" | "think",
  refs: readonly string[],
  placement: "branch" | "top"
) => {
  const step = refStep(kind, template(refs), "result");
  const lastName = placement === "top" ? "ref" : "fan";
  const event = kind === "think" ? "done" : "replied";

  const last =
    placement === "top"
      ? { meta: { step }, on: { [event]: { target: "end" } } }
      : {
          meta: {
            step: {
              branches: {
                a: {
                  initial: "plain",
                  states: {
                    done: { type: "final" },
                    plain: {
                      meta: { step: { kind: "think", prompt: "plain" } },
                      on: { done: { target: "done" } },
                    },
                  },
                },
                b: {
                  initial: "ref",
                  states: {
                    done: { type: "final" },
                    ref: {
                      meta: { step },
                      on: { [event]: { target: "done" } },
                    },
                  },
                },
              },
              join: "allSettled",
              kind: "parallel",
            },
          },
          on: { done: { target: "end" } },
        };

  return {
    defaults: { agent: {} },
    envelope,
    goal: "docs in prompts",
    id: "docs",
    machine: {
      id: "docs",
      initial: writers[0] === undefined ? lastName : `w_${writers[0]}`,
      states: chain(writers, last, lastName),
    },
    version: 1,
  };
};

it.effect.prop(
  "a {{docs.x}} reference is accepted exactly when some step writes x or x is seeded",
  {
    kind: Arbitrary.schema(Schema.Literals(["ask", "think"])),
    placement: Arbitrary.schema(Schema.Literals(["branch", "top"])),
    refs: Arbitrary.schema(Names),
    seeded: Arbitrary.schema(Names),
    writers: Arbitrary.schema(Names),
  },
  ({ kind, placement, refs, seeded, writers }) =>
    Effect.gen(function* property() {
      const unique = [...new Set(writers)];

      const exit = yield* Effect.exit(
        validatePlan(planWith(unique, kind, refs, placement), seeded)
      );

      const missing = [...new Set(refs)].filter(
        (name) => !unique.includes(name) && !seeded.includes(name)
      );

      const where = placement === "top" ? "ref" : "fan.b.ref";

      expect(Exit.isSuccess(exit)).toBe(missing.length === 0);

      for (const name of missing) {
        expect(String(Exit.isFailure(exit) && exit.cause)).toContain(
          `${where}: doc "${name}" is not written by any step and not seeded`
        );
      }
    }),
  { arbitrary: { runs: 200 } }
);

const hostWith = (prompts: string[], messages: string[]) =>
  RunHost.make.pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(
      Judge,
      Judge.of({ choose: () => Effect.die("unused") })
    ),
    Effect.provideService(
      Thinker,
      Thinker.of({
        decide: () => Effect.die("unused"),
        elaborate: () => Effect.die("unused"),
        think: ({ prompt }) => {
          prompts.push(prompt);

          return Effect.succeed({ output: `out(${prompt})`, tokens: 1 });
        },
      })
    ),
    Effect.provideService(
      Mail,
      Mail.of({
        seal: ({ key, message, runId, visit }) => {
          messages.push(message);

          return Effect.succeed({
            envelope: message,
            messageId: `${runId}/${key}#${visit}`,
          });
        },
        send: () => Effect.void,
      })
    ),
    Effect.provideService(Operator, Operator.of({ notify: () => Effect.void }))
  );

it.effect.prop(
  "a step sees each referenced doc's current text, seeded or written earlier",
  {
    kind: Arbitrary.schema(Schema.Literals(["ask", "think"])),
    refs: Arbitrary.schema(Names.check(Schema.isMinLength(1))),
    seed: Arbitrary.schema(
      Schema.Record(
        Schema.Literals(POOL),
        Schema.Union([Schema.String, Schema.Finite])
      )
    ),
  },
  ({ kind, refs, seed }) =>
    Effect.gen(function* property() {
      const prompts: string[] = [];
      const messages: string[] = [];
      const host = yield* hostWith(prompts, messages);
      const writers = POOL.filter((name) => !(name in seed));

      yield* host.submit("r", planWith(writers, kind, refs, "top"), seed);

      const written = Object.fromEntries(
        writers.map((name) => [name, `out(write ${name})`])
      );

      const docs = { ...written, ...seed };
      const expected = `use ${refs.map((name) => asText(docs[name] ?? "")).join(" and ")} now`;

      expect(kind === "think" ? prompts.at(-1) : messages.at(-1)).toBe(
        expected
      );
    }).pipe(Effect.provide(RunStore.memory)),
  { arbitrary: { runs: 60 } }
);

it.effect(
  "a reference to a doc written later on the path fails its step with a prompt",
  () =>
    Effect.gen(function* example() {
      const prompts: string[] = [];
      const host = yield* hostWith(prompts, []);

      const plan = {
        defaults: { agent: {} },
        envelope,
        goal: "early reads late",
        id: "early",
        machine: {
          id: "early",
          initial: "early",
          states: {
            early: {
              meta: { step: { kind: "think", prompt: "see {{docs.late}}" } },
              on: { done: { target: "late" } },
            },
            end: { type: "final" },
            late: {
              meta: {
                step: { kind: "think", prompt: "write it", writes: "late" },
              },
              on: { done: { target: "end" } },
            },
          },
        },
        version: 1,
      };

      yield* host.submit("r", plan);

      const docs = yield* RunStore.use((store) => store.readDocs("r"));

      expect(prompts).not.toContain("see {{docs.late}}");
      expect(docs["failed:early"]).toBe(true);
    }).pipe(Effect.provide(RunStore.memory))
);
