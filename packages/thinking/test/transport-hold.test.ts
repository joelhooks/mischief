// @effect-diagnostics nodeBuiltinImport:off -- The faux world keeps each run's SQLite thinking store in a temp directory.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "@effect/vitest";
import { Thinker } from "@mischief/core";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { constVoid } from "effect/Function";

import { piThinker } from "../dist/index.js";
import { callsOf, fauxWorld } from "./faux-world.js";

const DROPS = [
  "response stream: error decoding response body",
  "stream closed before response.completed",
  "read ECONNRESET",
  "connection reset by peer",
] as const;

const REFUSAL = "400 invalid request: unsupported parameter";

const FailureSchema = Schema.Literals([...DROPS, REFUSAL]);

type Failure = typeof FailureSchema.Type;

type Observed =
  | { readonly kind: "done" }
  | { readonly kind: "failed" }
  | { readonly kind: "held"; readonly status: number | null };

const expectedOf = (queue: Failure[], retried: boolean): Observed => {
  const next = queue.shift();

  if (next === undefined) {
    return { kind: "done" };
  }

  if (next === REFUSAL) {
    return { kind: "failed" };
  }

  return retried ? { kind: "held", status: null } : expectedOf(queue, true);
};

const PROMPT = "draft the plan";

it.effect.prop(
  "a transport drop with no HTTP status retries once in place and then holds the think, a 400 still fails it, and resuming lands one answer to one prompt with one model call per attempt",
  {
    failures: Arbitrary.schema(
      Schema.Array(FailureSchema).check(Schema.isMaxLength(6))
    ),
  },
  ({ failures }) =>
    Effect.gen(function* property() {
      const dir = mkdtempSync(path.join(tmpdir(), "mischief-drop-"));
      const served = [...failures];
      const model = [...failures];

      const thinkOnce = Thinker.use((thinker) =>
        thinker.think({
          agent: { model: "sol", thinking: "low" },
          ceiling: "high",
          epoch: 0,
          key: "draft",
          prompt: PROMPT,
          runId: "run-1",
          visit: 1,
        })
      ).pipe(
        Effect.provide(
          piThinker(fauxWorld(dir, false, constVoid, () => served.shift()))
        )
      );

      const observe = thinkOnce.pipe(
        Effect.as<Observed>({ kind: "done" }),
        Effect.catchTags({
          ProviderUnavailable: ({ error, status }) => {
            expect(DROPS.some((drop) => (error ?? "").includes(drop))).toBe(
              true
            );

            return Effect.succeed<Observed>({ kind: "held", status });
          },
          StepFailed: ({ reason }) => {
            expect(reason).toContain("HTTP 400");

            return Effect.succeed<Observed>({ kind: "failed" });
          },
        })
      );

      const expected = Array.from({ length: failures.length + 1 }, () =>
        expectedOf(model, false)
      );

      const observed: Observed[] = [];

      for (const step of expected) {
        observed.push(yield* observe);

        if (step.kind === "done") {
          break;
        }
      }

      expect(
        observed,
        "each think retries, holds, fails or answers as the drop schedule says"
      ).toStrictEqual(expected.slice(0, observed.length));

      const answered = yield* thinkOnce;

      expect(served, "every scripted drop reached the model").toHaveLength(0);
      expect(answered.output, "the answered attempt saw the prompt once").toBe(
        `answer:${PROMPT}:1`
      );
      expect(
        callsOf(dir),
        "one model call per attempt, and none after the answer"
      ).toHaveLength(failures.length + 1);
    }),
  { arbitrary: { runs: 40 }, timeout: 120_000 }
);
