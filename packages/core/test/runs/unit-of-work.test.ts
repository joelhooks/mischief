import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunLeftUncommitted } from "../../src/runs/run-left-uncommitted.js";
import {
  bufferedRunStore,
  memoryRunBackend,
} from "../../src/runs/run-store.js";
import { RunWriteOutsideUnit } from "../../src/runs/run-write-outside-unit.js";

const RUNS = ["one", "two"] as const;

const OpSchema = Schema.Union([
  Schema.Struct({
    name: Schema.Literals(["a", "b", "c"]),
    op: Schema.Literal("write"),
    run: Schema.Literals(RUNS),
    value: Schema.Int,
  }),
  Schema.Struct({
    op: Schema.Literals(["open", "commit", "discard", "close"]),
    run: Schema.Literals(RUNS),
  }),
]);

type Op = typeof OpSchema.Type;

interface Model {
  committed: Record<string, number>;
  depth: number;
  pending: Record<string, number>;
}

type Expected = "ok" | "outside" | "uncommitted";

const step = (model: Model, op: Op): Expected => {
  if (op.op === "write") {
    if (model.depth === 0) {
      return "outside";
    }

    model.pending[op.name] = op.value;

    return "ok";
  }

  if (op.op === "open") {
    model.depth += 1;

    return "ok";
  }

  if (op.op === "commit") {
    model.committed = { ...model.committed, ...model.pending };
    model.pending = {};

    return "ok";
  }

  if (op.op === "discard") {
    model.pending = {};

    return "ok";
  }

  if (model.depth > 1) {
    model.depth -= 1;

    return "ok";
  }

  const left = Object.keys(model.pending).length > 0;

  model.depth = 0;
  model.pending = {};

  return left ? "uncommitted" : "ok";
};

const outcomeOf = (exit: Exit.Exit<void>): Expected => {
  if (Exit.isSuccess(exit)) {
    return "ok";
  }

  const defect = Cause.squash(exit.cause);

  if (Schema.is(RunWriteOutsideUnit)(defect)) {
    return "outside";
  }

  return Schema.is(RunLeftUncommitted)(defect) ? "uncommitted" : "ok";
};

const effectOf = (
  store: ReturnType<typeof bufferedRunStore>,
  op: Op
): Effect.Effect<void> =>
  op.op === "write"
    ? store.writeDoc(op.run, op.name, op.value)
    : {
        close: store.close,
        commit: store.commit,
        discard: store.discard,
        open: store.open,
      }[op.op](op.run);

it.effect.prop(
  "every write is committed, discarded on purpose, or refused loudly; none vanishes",
  { ops: Arbitrary.schema(Schema.Array(OpSchema)) },
  ({ ops }) =>
    Effect.gen(function* unitOfWork() {
      const backend = memoryRunBackend();
      const store = bufferedRunStore(backend);

      const models = new Map<string, Model>(
        RUNS.map((run) => [run, { committed: {}, depth: 0, pending: {} }])
      );

      for (const op of ops) {
        const model = models.get(op.run) ?? {
          committed: {},
          depth: 0,
          pending: {},
        };

        const expected = step(model, op);

        const exit = yield* Effect.exit(effectOf(store, op));

        expect(outcomeOf(exit), `${op.op} on ${op.run}`).toBe(expected);
      }

      for (const run of RUNS) {
        expect(yield* backend.readDocs(run)).toStrictEqual(
          models.get(run)?.committed
        );
      }
    }),
  { arbitrary: { runs: 400 } }
);
