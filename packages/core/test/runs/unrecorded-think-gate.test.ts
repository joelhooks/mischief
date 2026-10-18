import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  EnabledStepKinds,
  STEP_KINDS_FLAG,
} from "../../src/plans/step-kinds.js";
import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import { CallRegistry, callable } from "../../src/steps/call-registry.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";

const RUN = "gate-run";

const Named = Schema.Literals(["none", "known", "unknown"]);

const GateSchema = Schema.Struct({
  both: Schema.Boolean,
  ephemeral: Named,
  on: Schema.Boolean,
  post: Named,
  wired: Schema.Boolean,
});

type Gate = typeof GateSchema.Type;

const nameOf = (named: typeof Named.Type, known: string) =>
  named === "known" ? known : `missing-${known}`;

const ephemeralOf = (
  gate: Gate
): readonly (readonly [string, Schema.Json])[] =>
  gate.ephemeral === "none"
    ? []
    : [
        [
          "ephemeral",
          Object.fromEntries<Schema.Json>([
            ["capability", nameOf(gate.ephemeral, "fetch")],
            ["input", { id: 7 }],
            ...(gate.both ? [["reads", []] as const] : []),
          ]),
        ],
      ];

const stepOf = (gate: Gate) =>
  Object.fromEntries<Schema.Json>([
    ["kind", "think"],
    ["prompt", "summarise"],
    ["writes", "out"],
    ...ephemeralOf(gate),
    ...(gate.post === "none"
      ? []
      : [["post", { capability: nameOf(gate.post, "shrink") }] as const]),
  ]);

const planOf = (gate: Gate) => ({
  defaults: { agent: {} },
  envelope: {
    maxAgents: 2,
    maxDepth: 3,
    maxSteps: 20,
    maxThinking: "low",
    models: ["m"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  id: "gate",
  machine: {
    id: "gate",
    initial: "think",
    states: {
      end: { type: "final" },
      think: {
        meta: { step: stepOf(gate) },
        on: { done: { target: "end" } },
      },
    },
  },
});

const REGISTERED = "Registered: fetch, shrink. Use one of those names";

const expectedRefusals = (gate: Gate): readonly string[] => {
  if (gate.ephemeral === "none" && gate.post === "none") {
    return [];
  }

  if (!gate.on) {
    return [
      `think: a think with ephemeral or post calls host capabilities, so it needs step kind "call", which is off on this host. A host turns it on with ${STEP_KINDS_FLAG}=call, and turning it on for real runs needs Joel's approval, so ask Joel before setting it. Until then, drop ephemeral and post from this think, then call submitPlan again`,
    ];
  }

  const ephemeral =
    gate.ephemeral === "none"
      ? []
      : [
          ...(gate.ephemeral === "unknown"
            ? [
                `think: ephemeral names capability "missing-fetch", which this host has not registered. ${REGISTERED}`,
              ]
            : []),
          ...(gate.both
            ? [
                "think: ephemeral takes its input from input or from reads, not both. Keep input for a fixed value, or reads to pass docs by name",
              ]
            : []),
        ];

  const post = {
    known: [],
    none: [
      'think: a think with ephemeral needs post. The model\'s answer can quote the ephemeral text, so the run never records it; post names the capability whose output is recorded instead. Add post: { capability: "<name>" }',
    ],
    unknown: [
      `think: post names capability "missing-shrink", which this host has not registered. ${REGISTERED}`,
    ],
  }[gate.post];

  return [...ephemeral, ...post];
};

it.effect.prop(
  "a think with ephemeral or post is refused while call is off, names unregistered capabilities and a missing post, stores nothing when refused, and never falls back to a recorded think",
  { gate: Arbitrary.schema(GateSchema) },
  ({ gate }) =>
    Effect.gen(function* gated() {
      const invoked: string[] = [];

      const answered =
        (name: string) =>
        ({ prompt }: { readonly prompt: string }) =>
          Effect.sync(() => {
            invoked.push(name);

            return { output: prompt, tokens: 1 };
          });

      const recordedOnly = {
        decide: () => Effect.die("unused"),
        elaborate: () => Effect.die("unused"),
        think: answered("think"),
      };

      const thinker = Thinker.of(
        gate.wired
          ? { ...recordedOnly, thinkUnrecorded: answered("thinkUnrecorded") }
          : recordedOnly
      );

      const registry = new Map([
        [
          "fetch",
          callable({
            input: Schema.Struct({ id: Schema.Int }),
            output: Schema.String,
            run: ({ id }) =>
              Effect.sync(() => {
                invoked.push("fetch");

                return `item ${id}`;
              }),
          }),
        ],
        [
          "shrink",
          callable({
            input: Schema.Struct({ answer: Schema.String }),
            output: Schema.Int,
            run: ({ answer }) =>
              Effect.sync(() => {
                invoked.push("shrink");

                return answer.length;
              }),
          }),
        ],
      ]);

      const build = RunHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Judge.unwired,
            Mail.unwired,
            Layer.succeed(Thinker, thinker),
            Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
          )
        ),
        Effect.provideService(CallRegistry, registry)
      );

      const host = yield* gate.on
        ? build.pipe(
            Effect.provideService(EnabledStepKinds, new Set(["call"] as const))
          )
        : build;

      const result = yield* Effect.result(host.submit(RUN, planOf(gate)));
      const refusals = expectedRefusals(gate);

      if (refusals.length > 0) {
        expect(Result.isFailure(result) && result.failure.errors).toStrictEqual(
          refusals
        );
        expect(invoked).toStrictEqual([]);
        expect(Option.isNone(yield* (yield* RunStore).readRun(RUN))).toBe(true);

        return;
      }

      const report = Result.getOrThrow(result);

      if (gate.post === "none") {
        expect(report.status).toBe("done");
        expect(invoked).toStrictEqual(["think"]);

        return;
      }

      if (!gate.wired) {
        expect(report.status).toBe("failed");
        expect(report.failures?.map(({ reason }) => reason)).toStrictEqual([
          expect.stringContaining(
            "this host's Thinker cannot think without recording the conversation"
          ),
        ]);
        expect(invoked).toStrictEqual([]);

        return;
      }

      const fetched = gate.ephemeral === "known";
      const prompt = fetched ? "summarise\n\nitem 7" : "summarise";

      expect(report.status).toBe("done");
      expect(report.docs).toStrictEqual({ out: prompt.length });
      expect(invoked).toStrictEqual([
        ...(fetched ? ["fetch"] : []),
        "thinkUnrecorded",
        "shrink",
      ]);
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 80 } }
);
