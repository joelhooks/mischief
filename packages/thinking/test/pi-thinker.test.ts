// @effect-diagnostics nodeBuiltinImport:off -- The crash property kills a real child process with SIGKILL mid-step and reopens its SQLite store, so it spawns Node processes at this test boundary.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "@effect/vitest";
import { Thinker } from "@mischief/core";
import { Effect, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { piThinker } from "../dist/index.js";
import { callsOf, fauxWorld } from "./faux-world.js";

const CHILD = path.join(import.meta.dirname, "crash-child.mjs");

const RUN = "run-1";

const StepSchema = Schema.Struct({
  crash: Schema.Literals(["none", "mid-call", "after-answer"]),
  epoch: Schema.Literals([0, 2]),
  key: Schema.Literals(["draft", "review", "ship"]),
  visit: Schema.Int.check(Schema.isBetween({ maximum: 2, minimum: 1 })),
});

type Step = typeof StepSchema.Type;

const promptOf = ({ epoch, key, visit }: Step) =>
  `write ${key} pass ${visit} plan ${epoch}`;

const crashChild = (dir: string, step: Step) =>
  Effect.callback<string>((resume) => {
    const child = spawn(
      process.execPath,
      [
        CHILD,
        dir,
        RUN,
        step.key,
        String(step.visit),
        promptOf(step),
        String(step.epoch),
        step.crash === "mid-call" ? "hang" : "answer",
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );

    const marker = step.crash === "mid-call" ? "CALLED" : "ANSWERED";
    let seen = "";

    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString();

      if (seen.includes(marker) || seen.includes("FAILED")) {
        child.kill("SIGKILL");
      }
    });
    child.on("exit", () => {
      resume(Effect.succeed(seen));
    });
  });

const thinkHere = (dir: string, step: Step) =>
  Effect.gen(function* here() {
    const thinker = yield* Thinker;

    return yield* thinker.think({
      agent: { model: "sol", thinking: "low" },
      ceiling: "high",
      epoch: step.epoch,
      key: step.key,
      prompt: promptOf(step),
      runId: RUN,
      visit: step.visit,
    });
  }).pipe(Effect.provide(piThinker(fauxWorld(dir, false))));

it.effect.prop(
  "a think step killed at any point resumes into one answer, and only a crash before the answer calls the model again",
  {
    steps: Arbitrary.schema(
      Schema.Array(StepSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(4)
      )
    ),
  },
  ({ steps }) =>
    Effect.gen(function* property() {
      const dir = mkdtempSync(path.join(tmpdir(), "mischief-thinking-"));
      const seen = new Map<string, Step>();

      for (const step of steps) {
        const address = `${step.key}#${step.visit}@${step.epoch}`;
        const first = !seen.has(address);

        if (first) {
          seen.set(address, step);
        }

        if (first && step.crash !== "none") {
          const output = yield* crashChild(dir, step);

          expect(output).not.toContain("FAILED");
        }

        const thought = yield* thinkHere(dir, step);
        const original = seen.get(address) ?? step;

        expect(thought.output).toBe(`answer:${promptOf(step)}:1`);
        expect(
          callsOf(dir).filter((line) => line === promptOf(step))
        ).toHaveLength(original.crash === "mid-call" ? 2 : 1);
      }
    }),
  { arbitrary: { runs: 12 }, timeout: 120_000 }
);

it.effect.prop(
  "decide accepts only an offered choice with its stated confidence",
  {
    choice: Arbitrary.schema(Schema.Literals(["ship", "hold", "nope"])),
    confidence: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 0 }))
    ),
  },
  ({ choice, confidence }) =>
    Effect.gen(function* property() {
      const dir = mkdtempSync(path.join(tmpdir(), "mischief-decide-"));

      const deliberation = yield* Effect.gen(function* decide() {
        const thinker = yield* Thinker;

        return yield* thinker.decide({
          agent: { model: "sol" },
          ceiling: "high",
          epoch: 0,
          key: "gate",
          options: ["ship", "hold"],
          question: `pick:${choice}:${confidence / 100}`,
          runId: RUN,
          visit: 1,
        });
      }).pipe(Effect.provide(piThinker(fauxWorld(dir, false))));

      expect(deliberation.decision).toEqual(
        choice === "nope"
          ? Option.none()
          : Option.some({ choice, confidence: confidence / 100 })
      );
    }),
  { arbitrary: { runs: 20 } }
);
