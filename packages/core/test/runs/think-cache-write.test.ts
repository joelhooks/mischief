import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { thinkLine, thinkTotals } from "../../src/steps/receipt.js";
import type { ThinkReceipt } from "../../src/steps/receipt.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const Tally = Schema.Int.check(
  Schema.isBetween({ maximum: 50_000, minimum: 0 })
);

const CallSchema = Schema.Struct({
  cacheRead: Tally,
  cacheWrite: Tally,
  input: Tally,
  output: Tally,
});

type Call = typeof CallSchema.Type;

const NAMES = ["a", "b", "c", "d", "e", "f"] as const;

const planOf = (length: number) => {
  const names = NAMES.slice(0, length);

  return {
    defaults: { agent: {} },
    envelope: {
      maxAgents: 6,
      maxDepth: 3,
      maxSteps: 40,
      maxThinking: "low",
      models: ["sol"],
      names: [],
      thresholds: { judge: 0.8 },
    },
    goal: "count the cache",
    id: "cache",
    machine: {
      id: "cache",
      initial: "a",
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

const receiptOf = ({
  cacheRead,
  cacheWrite,
  input,
  output,
}: Call): ThinkReceipt => ({
  effective: { model: "sol", thinking: "low" },
  latencyMs: 1,
  matched: true,
  requested: { from: "plan", model: "sol", thinking: "low" },
  tokens: {
    cacheRead,
    cacheWrite,
    input,
    output,
    total: input + output + cacheRead + cacheWrite,
  },
});

const sumOf = (calls: readonly Call[], pick: (call: Call) => number) =>
  calls.reduce((total, call) => total + pick(call), 0);

const hostOf = (calls: readonly Call[]) =>
  RunHost.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        RunStore.memory,
        Layer.succeed(
          Thinker,
          Thinker.of({
            decide: () => Effect.die("unused"),
            elaborate: () => Effect.die("unused"),
            think: ({ prompt }) => {
              const call = calls.find((_, index) => NAMES[index] === prompt);

              return call === undefined
                ? Effect.die("no usage generated for this step")
                : Effect.succeed({
                    cacheRead: call.cacheRead,
                    cacheWrite: call.cacheWrite,
                    output: prompt,
                    receipt: receiptOf(call),
                    tokens: receiptOf(call).tokens.total,
                  });
            },
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
      )
    )
  );

it.effect(
  "a think that wrote 9,080 cache tokens carries them in a named field",
  () =>
    Effect.gen(function* cacheWritten() {
      const host = yield* hostOf([
        { cacheRead: 0, cacheWrite: 9080, input: 2, output: 12_265 },
      ]);

      const report = yield* host.submit("run", planOf(1));

      expect(report.thinking?.tokens).toEqual({
        cacheRead: 0,
        cacheWrite: 9080,
        input: 2,
        output: 12_265,
        total: 21_347,
      });
      expect(report.thinking?.line).toBe(
        "think: sol/low · 1 call · 21,347 tok (0 cached) · 9,080 cache-write"
      );
    })
);

it.effect.prop(
  "receipt totals are the sums of each field, cache writes included, and total is input plus output plus cache reads plus cache writes",
  {
    calls: Arbitrary.schema(
      Schema.Array(CallSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(NAMES.length)
      )
    ),
  },
  ({ calls }) =>
    Effect.gen(function* totals() {
      const host = yield* hostOf(calls);

      const report = yield* host.submit("run", planOf(calls.length));

      const tokens = report.thinking?.tokens;

      expect(tokens?.cacheRead).toBe(sumOf(calls, (call) => call.cacheRead));
      expect(tokens?.cacheWrite).toBe(sumOf(calls, (call) => call.cacheWrite));
      expect(tokens?.input).toBe(sumOf(calls, (call) => call.input));
      expect(tokens?.output).toBe(sumOf(calls, (call) => call.output));
      expect(tokens?.total).toBe(
        (tokens?.input ?? 0) +
          (tokens?.output ?? 0) +
          (tokens?.cacheRead ?? 0) +
          (tokens?.cacheWrite ?? 0)
      );

      const record = yield* host.read("run");

      expect(
        record.journal
          .filter(({ key }) => key.startsWith("logic:"))
          .map(({ entry }) => entry)
      ).toEqual(
        calls.map((call, index) => ({
          cacheRead: call.cacheRead,
          cacheWrite: call.cacheWrite,
          output: NAMES[index],
          receipt: receiptOf(call),
          tokens: receiptOf(call).tokens.total,
        }))
      );

      const written = sumOf(calls, (call) => call.cacheWrite);

      expect(report.thinking?.line.includes("cache-write")).toBe(written > 0);
      expect(report.thinking?.line.endsWith(" cache-write")).toBe(written > 0);
    }),
  { arbitrary: { runs: 40 } }
);

it.prop(
  "a receipt stored before cache writes were counted decodes with zero, and its line is the line it always had",
  {
    cacheRead: Tally,
    input: Tally,
    output: Tally,
  },
  ({ cacheRead, input, output }) => {
    const stored = {
      receipt: {
        effective: { model: "sol", thinking: "low" },
        latencyMs: 1,
        matched: true,
        requested: { from: "plan", model: "sol", thinking: "low" },
        tokens: {
          cacheRead,
          input,
          output,
          total: input + output + cacheRead,
        },
      },
    };

    const totals = thinkTotals([stored]);

    expect(totals?.tokens.cacheWrite).toBe(0);
    expect(totals === undefined ? "" : thinkLine(totals)).toBe(
      `think: sol/low · 1 call · ${(input + output + cacheRead).toLocaleString("en-US")} tok (${cacheRead.toLocaleString("en-US")} cached)`
    );
  }
);
