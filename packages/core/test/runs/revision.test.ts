import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunStore, withinRun } from "../../src/runs/run-store.js";
import type { RunReport } from "../../src/runs/schema.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { StepFailed } from "../../src/steps/step-failed.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const StepSchema = Schema.Struct({
  base: Schema.Literals(["a", "b", "c"]),
  link: Schema.Boolean,
  stable: Schema.Boolean,
});

type Line = readonly (typeof StepSchema.Type)[];

const LineSchema = Schema.Array(StepSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(5)
);

const promptOf = (line: Line, index: number) => {
  const step = line[index];

  return step?.link === true && index > 0
    ? `${step.base} {{docs.d${index - 1}}}`
    : (step?.base ?? "");
};

const fullPrompt = (line: Line, index: number) =>
  `${line[index]?.stable === true ? "stable " : ""}${promptOf(line, index)}`;

const thoughtOf = (prompt: string) =>
  prompt.startsWith("stable ") ? "same" : `out:${prompt}`;

const askTemplate = (line: Line, askReads: boolean) =>
  askReads ? `ship {{docs.d${line.length - 1}}}?` : "ship it?";

const planOf = (line: Line, askReads = false) => ({
  defaults: { agent: {} },
  envelope: {
    maxAgents: 10,
    maxDepth: 3,
    maxSteps: 200,
    maxThinking: "low",
    models: ["sol"],
    names: ["desk"],
    thresholds: { judge: 0.8 },
  },
  goal: "a line, a question for the desk, and a gate",
  id: "line",
  machine: {
    id: "line",
    initial: "s0",
    states: {
      ask: {
        meta: {
          step: {
            kind: "ask",
            message: askTemplate(line, askReads),
            to: "desk",
            writes: "verdict",
          },
        },
        on: { replied: { target: "gate" } },
      },
      end: { type: "final" },
      gate: {
        meta: { step: { kind: "ask-joel", question: "done?" } },
        on: { done: { target: "end" }, redo: { target: "s0" } },
      },
      ...Object.fromEntries(
        line.map((step, index) => [
          `s${index}`,
          {
            meta: {
              step: {
                kind: "think",
                prompt: `${step.stable ? "stable " : ""}${promptOf(line, index)}`,
                writes: `d${index}`,
              },
            },
            on: {
              done: {
                target: index === line.length - 1 ? "ask" : `s${index + 1}`,
              },
            },
          },
        ])
      ),
    },
  },
});

const modelDocs = (line: Line) => {
  const docs: Record<string, string> = {};

  for (const [index, step] of line.entries()) {
    const read =
      step.link && index > 0 ? ` ${docs[`d${index - 1}`] ?? ""}` : "";

    const prompt = `${step.stable ? "stable " : ""}${step.base}${read}`;

    docs[`d${index}`] = thoughtOf(prompt);
  }

  return docs;
};

const modelReruns = (before: Line, after: Line) => {
  const old = modelDocs(before);
  const now = modelDocs(after);

  return after.flatMap((step, index) => {
    const promptChanged =
      index >= before.length ||
      fullPrompt(before, index) !== fullPrompt(after, index);

    const inputChanged =
      step.link && index > 0 && old[`d${index - 1}`] !== now[`d${index - 1}`];

    return promptChanged || inputChanged ? [index] : [];
  });
};

const askReruns = (before: Line, after: Line, askReads: boolean) =>
  askReads &&
  (askTemplate(before, true) !== askTemplate(after, true) ||
    modelDocs(before)[`d${before.length - 1}`] !==
      modelDocs(after)[`d${after.length - 1}`]);

const keyOf = (keys: readonly string[], index: number) =>
  keys.filter((key) => key.includes(`.s${index}#`));

interface Trap {
  at: "none" | "send" | "think";
  failing: string;
}

const firstLive = (
  reruns: readonly number[],
  ask: boolean,
  keys: readonly string[]
) => {
  if (reruns.length > 0) {
    return keyOf(keys, reruns[0] ?? 0);
  }

  return ask ? keys.filter((key) => key.includes(".ask#")) : [];
};

const statusAfterRevision = (ask: boolean, diverged: boolean) => {
  if (ask) {
    return "waiting-for-reply";
  }

  return diverged ? "waiting-for-joel" : "done";
};

const trapFor = (reruns: readonly number[], ask: boolean): Trap["at"] => {
  if (reruns.length > 0) {
    return "think";
  }

  return ask ? "send" : "none";
};

const world = (hang?: Deferred.Deferred<string>) => {
  const counts = { notified: 0, sealed: 0, sent: 0, thought: 0 };
  const answered = new Map<string, string>();

  const trap: Trap = { at: "none", failing: "" };

  const sprung = () =>
    hang === undefined
      ? Effect.never
      : Deferred.succeed(hang, "sprung").pipe(Effect.andThen(Effect.never));

  const layer = Layer.mergeAll(
    NodeCrypto.layer,
    RunStore.memory,
    Layer.succeed(
      Thinker,
      Thinker.of({
        decide: () => Effect.die("unused"),
        elaborate: () => Effect.die("unused"),
        think: ({ epoch, key, prompt, visit }) =>
          Effect.suspend(() => {
            counts.thought += 1;

            if (trap.at === "think") {
              trap.at = "none";

              return sprung();
            }

            if (trap.failing !== "" && key === trap.failing) {
              trap.failing = "";

              return Effect.fail(
                new StepFailed({ key: "think", reason: "flaked once" })
              );
            }

            const address = `${key}#${visit}@${epoch}`;
            const output = answered.get(address) ?? thoughtOf(prompt);

            answered.set(address, output);

            return Effect.succeed({ output, tokens: 1 });
          }),
      })
    ),
    Layer.succeed(Judge, Judge.of({ choose: () => Effect.die("unused") })),
    Layer.succeed(
      Mail,
      Mail.of({
        seal: ({ key, message, runId, visit }) =>
          Effect.sync(() => {
            counts.sealed += 1;

            return {
              envelope: message,
              messageId: `${runId}/${key}#${visit}#${counts.sealed}`,
            };
          }),
        send: () =>
          Effect.suspend(() => {
            counts.sent += 1;

            if (trap.at === "send") {
              trap.at = "none";

              return sprung();
            }

            return Effect.void;
          }),
      })
    ),
    Layer.succeed(
      Operator,
      Operator.of({
        notify: () =>
          Effect.sync(() => {
            counts.notified += 1;
          }),
      })
    )
  );

  return { counts, layer, trap };
};

const settle = (host: RunHost["Service"], from: RunReport) =>
  Effect.gen(function* settleRun() {
    let report = from;

    for (let turn = 0; turn < 6 && report.status !== "done"; turn += 1) {
      const [open] = report.awaiting ?? [];

      report =
        report.status === "waiting-for-reply"
          ? yield* host.deliver({
              body: "yes",
              from: "desk",
              replyTo: open?.messageId ?? "",
            })
          : yield* host.answer("run", "done");
    }

    return report;
  });

const snapshotOf = (store: RunStore["Service"]) =>
  Effect.gen(function* snapshot() {
    return {
      docs: yield* store.readDocs("run"),
      journal: Object.fromEntries(yield* store.readJournal("run")),
      prints: Object.fromEntries(yield* store.readFingerprints("run")),
      state: Option.getOrNull(yield* store.readRun("run")),
    };
  });

const ArbitrariesFor = {
  after: Arbitrary.schema(LineSchema),
  askReads: Arbitrary.schema(Schema.Boolean),
  before: Arbitrary.schema(LineSchema),
  drop: Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 0 }))
  ),
};

const revisionOf = (before: Line, after: Line, drop: number) =>
  before
    .map((step, index) => after[index] ?? step)
    .slice(0, Math.max(1, before.length - drop));

it.effect.prop(
  "a revision reuses every step whose inputs held, reruns exactly the rest, and never asks the desk twice",
  ArbitrariesFor,
  ({ after, askReads, before, drop }) => {
    const { counts, layer } = world();
    const revised = revisionOf(before, after, drop);

    return Effect.gen(function* property() {
      const host = yield* RunHost.make;
      const store = yield* RunStore;

      yield* settle(host, yield* host.submit("run", planOf(before, askReads)));

      const keys = Object.keys(
        Object.fromEntries(yield* store.readJournal("run"))
      ).filter((key) => key.startsWith("logic:"));

      const firstDone = { ...counts };
      const preview = yield* snapshotOf(store);
      const reruns = modelReruns(before, revised);
      const ask = askReruns(before, revised, askReads);
      const diverged = reruns.length > 0 || ask;

      const dry = yield* host.revise("run", planOf(revised, askReads), true);

      expect(yield* snapshotOf(store)).toEqual(preview);
      expect(counts).toEqual(firstDone);
      expect(dry.live).toEqual(firstLive(reruns, ask, keys));

      const committed = yield* host.revise(
        "run",
        planOf(revised, askReads),
        false
      );

      expect(committed.live).toEqual(dry.live);
      expect(committed.run.status).toBe(statusAfterRevision(ask, diverged));
      expect((yield* settle(host, committed.run)).status).toBe("done");
      expect({
        notified: counts.notified - firstDone.notified,
        sealed: counts.sealed - firstDone.sealed,
        sent: counts.sent - firstDone.sent,
        thought: counts.thought - firstDone.thought,
      }).toEqual({
        notified: diverged ? 1 : 0,
        sealed: ask ? 1 : 0,
        sent: ask ? 1 : 0,
        thought: reruns.length,
      });

      const docs = yield* store.readDocs("run");

      expect(
        Object.fromEntries(
          Object.entries(docs).filter(([name]) => /^d\d$/u.test(name))
        )
      ).toEqual(modelDocs(revised));
      expect(docs.verdict).toBe("yes");
    }).pipe(Effect.provide(layer));
  },
  { arbitrary: { runs: 200 } }
);

it.effect.prop(
  "a revision that crashes mid-commit resumes to the same end, repeating only the work it was doing and sealing each ask once",
  ArbitrariesFor,
  ({ after, askReads, before, drop }) =>
    Effect.gen(function* property() {
      const hang = yield* Deferred.make<string>();
      const { counts, layer, trap } = world(hang);
      const revised = revisionOf(before, after, drop);
      const reruns = modelReruns(before, revised);
      const ask = askReruns(before, revised, askReads);

      yield* Effect.gen(function* crashThenResume() {
        const first = yield* RunHost.make;

        yield* settle(
          first,
          yield* first.submit("run", planOf(before, askReads))
        );

        const firstDone = { ...counts };

        trap.at = trapFor(reruns, ask);

        const fiber = yield* Effect.forkChild(
          first.revise("run", planOf(revised, askReads), false)
        );

        if (trap.at === "none") {
          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true);
        } else {
          yield* Deferred.await(hang);
          yield* Fiber.interrupt(fiber);
        }

        const second = yield* RunHost.make;
        const ended = yield* settle(second, yield* second.advance("run"));
        const docs = yield* (yield* RunStore).readDocs("run");

        expect(ended.status).toBe("done");
        expect({
          sealed: counts.sealed - firstDone.sealed,
          thought: counts.thought - firstDone.thought,
        }).toEqual({
          sealed: ask ? 1 : 0,
          thought: reruns.length === 0 ? 0 : reruns.length + 1,
        });
        expect(
          Object.fromEntries(
            Object.entries(docs).filter(([name]) => /^d\d$/u.test(name))
          )
        ).toEqual(modelDocs(revised));
      }).pipe(Effect.provide(layer));
    }),
  { arbitrary: { runs: 150 } }
);

it.effect.prop(
  "a revision reruns a failed step instead of reusing its failure",
  {
    at: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 0 }))
    ),
    line: Arbitrary.schema(LineSchema),
  },
  ({ at, line }) =>
    Effect.gen(function* property() {
      const { counts, layer, trap } = world();
      const failing = at % line.length;

      yield* Effect.gen(function* failThenRevise() {
        const host = yield* RunHost.make;

        trap.failing = `s${failing}`;

        const failed = yield* host.submit("run", planOf(line));

        expect(failed.status).toBe("failed");

        const { thought } = counts;
        const revised = yield* host.revise("run", planOf(line), false);

        expect(revised.reused).toHaveLength(failing);
        expect(counts.thought - thought).toBe(line.length - failing);
        expect((yield* settle(host, revised.run)).status).toBe("done");
      }).pipe(Effect.provide(layer));
    }),
  { arbitrary: { runs: 60 } }
);

const RefusalSchema = Schema.Literals([
  "no-log",
  "aborted",
  "invalid",
  "envelope",
]);

it.effect.prop(
  "a revision the host cannot make is refused with what to do instead, and changes nothing",
  {
    kind: Arbitrary.schema(RefusalSchema),
    line: Arbitrary.schema(LineSchema),
  },
  ({ kind, line }) =>
    Effect.gen(function* property() {
      const { counts, layer } = world();

      yield* Effect.gen(function* refuse() {
        const host = yield* RunHost.make;
        const store = yield* RunStore;

        yield* host.submit("run", planOf(line));

        if (kind === "no-log") {
          const state = Option.getOrThrow(yield* store.readRun("run"));

          yield* withinRun(
            store,
            "run"
          )(store.writeRun("run", { ...state, seeded: null }));
        }

        if (kind === "aborted") {
          yield* host.abort("run");
        }

        const plan = planOf(line);

        const revised = Match.value(kind).pipe(
          Match.when("invalid", () => ({
            ...plan,
            machine: { ...plan.machine, initial: "nowhere" },
          })),
          Match.when("envelope", () => ({
            ...plan,
            envelope: { ...plan.envelope, maxAgents: 11 },
          })),
          Match.orElse(() => plan)
        );

        const before = yield* snapshotOf(store);
        const { thought } = counts;
        const exit = yield* Effect.exit(host.revise("run", revised, false));
        const text = String(Exit.isFailure(exit) && exit.cause);

        const says = {
          aborted: "submitPlan the revised plan as a new run",
          envelope: "call extendRun",
          invalid: "call reviseRun again",
          "no-log": "cannot be rebuilt",
        }[kind];

        expect(text).toContain("RevisionRefused");
        expect(text).toContain(says);
        expect(yield* snapshotOf(store)).toEqual(before);
        expect(counts.thought).toBe(thought);
      }).pipe(Effect.provide(layer));
    }),
  { arbitrary: { runs: 40 } }
);
