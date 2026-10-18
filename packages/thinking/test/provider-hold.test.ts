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

const HOLDS = [408, 429, 502, 503] as const;

const RETRIES = [500, 507, 520] as const;

const FAILS = [400, 401, 404] as const;

const StatusSchema = Schema.Literals([...HOLDS, ...RETRIES, ...FAILS]);

type Status = typeof StatusSchema.Type;

const FormatSchema = Schema.Literals(["sdk", "normalized", "prefixed"]);

const FailureSchema = Schema.Struct({
  format: FormatSchema,
  status: StatusSchema,
});

type Failure = typeof FailureSchema.Type;

const BODY = JSON.stringify({
  error: { code: "model_cooldown", message: "busy", reset_seconds: 7 },
});

const FORMATS: Readonly<
  Record<typeof FormatSchema.Type, (status: number) => string>
> = {
  normalized: (status) => `${status}: ${BODY}`,
  prefixed: (status) => `Proxy API error (${status}): ${BODY}`,
  sdk: (status) => `${status} ${BODY}`,
};

const inSet = (set: readonly number[], status: Status) => set.includes(status);

type Observed =
  | { readonly kind: "done" }
  | { readonly kind: "held"; readonly status: number | null }
  | { readonly kind: "failed"; readonly status: number | null };

const expectedOf = (queue: Failure[], retried: boolean): Observed => {
  const next = queue.shift();

  if (next === undefined) {
    return { kind: "done" };
  }

  if (inSet(FAILS, next.status)) {
    return { kind: "failed", status: next.status };
  }

  if (inSet(HOLDS, next.status) || retried) {
    return { kind: "held", status: next.status };
  }

  return expectedOf(queue, true);
};

const REFUSED = /HTTP (?<status>\d{3})/u;

const PROMPT = "draft the plan";

it.effect.prop(
  "a proxy failure holds or fails the think by its status, a retry status retries once before holding, and resuming lands one answer to one prompt in the same conversation",
  {
    failures: Arbitrary.schema(
      Schema.Array(FailureSchema).check(Schema.isMaxLength(6))
    ),
  },
  ({ failures }) =>
    Effect.gen(function* property() {
      const dir = mkdtempSync(path.join(tmpdir(), "mischief-hold-"));
      const served = [...failures];
      const model = [...failures];

      const thinkOnce = Effect.gen(function* once() {
        const thinker = yield* Thinker;

        return yield* thinker.think({
          agent: { model: "sol", thinking: "low" },
          ceiling: "high",
          epoch: 0,
          key: "draft",
          prompt: PROMPT,
          runId: "run-1",
          visit: 1,
        });
      }).pipe(
        Effect.provide(
          piThinker(
            fauxWorld(dir, false, constVoid, () => {
              const next = served.shift();

              return next === undefined
                ? undefined
                : FORMATS[next.format](next.status);
            })
          )
        )
      );

      const observe = thinkOnce.pipe(
        Effect.as<Observed>({ kind: "done" }),
        Effect.catchTags({
          ProviderUnavailable: ({ provider, status }) => {
            expect(provider).toMatch(/^faux\//u);

            return Effect.succeed<Observed>({ kind: "held", status });
          },
          StepFailed: ({ reason }) =>
            Effect.succeed<Observed>({
              kind: "failed",
              status: Number(REFUSED.exec(reason)?.groups?.status ?? "0"),
            }),
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
        "each think holds, fails or answers as the status table says"
      ).toStrictEqual(expected.slice(0, observed.length));
      expect(observed.at(-1)).toStrictEqual({ kind: "done" });

      const answered = yield* thinkOnce;

      expect(served, "every scripted failure reached the model").toHaveLength(
        0
      );
      expect(answered.output, "the answered attempt saw the prompt once").toBe(
        `answer:${PROMPT}:1`
      );
      expect(
        callsOf(dir),
        "a replay after the answer never calls the model again"
      ).toHaveLength(failures.length + 1);
    }),
  { arbitrary: { runs: 40 }, timeout: 120_000 }
);
