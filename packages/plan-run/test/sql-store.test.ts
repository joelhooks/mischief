import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { RunStore } from "@mischief/core";
import type { Plan, RunStateSchema } from "@mischief/core";
import { Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { nodeSqlStorage } from "../src/node-sql.js";
import { runStoreSql } from "../src/sql-store.js";
import type { SqlStorage } from "../src/sql.js";

const RUNS = ["one", "two"] as const;

const NAMES = ["brief", "draft", "verdict"] as const;

const Leaf = Schema.Union([
  Schema.String.check(Schema.isMaxLength(12)),
  Schema.Literals([-7, 0, 1, 42, 1_000_000]),
  Schema.Boolean,
  Schema.Null,
]);

const Value = Schema.Union([
  Leaf,
  Schema.Array(Leaf).check(Schema.isMaxLength(3)),
  Schema.Record(Schema.Literals(["a", "b"]), Leaf),
]);

const Run = Schema.Literals(RUNS);

const Name = Schema.Literals(NAMES);

const OpSchema = Schema.Union([
  Schema.Struct({
    name: Name,
    op: Schema.Literal("doc"),
    run: Run,
    value: Value,
  }),
  Schema.Struct({
    docs: Schema.Record(Name, Value),
    op: Schema.Literal("replace"),
    run: Run,
  }),
  Schema.Struct({
    key: Name,
    op: Schema.Literal("journal"),
    run: Run,
    value: Value,
  }),
  Schema.Struct({
    key: Name,
    op: Schema.Literal("print"),
    print: Schema.String.check(Schema.isMaxLength(8)),
    run: Run,
  }),
  Schema.Struct({
    op: Schema.Literal("pause"),
    paused: Schema.Boolean,
    run: Run,
  }),
  Schema.Struct({ id: Name, op: Schema.Literal("message"), run: Run }),
  Schema.Struct({
    op: Schema.Literal("state"),
    run: Run,
    transitions: Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 })),
  }),
  Schema.Struct({
    op: Schema.Literal("plan"),
    run: Run,
    version: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
  }),
  Schema.Struct({ op: Schema.Literal("commit"), run: Run }),
]);

type Op = typeof OpSchema.Type;

const stateWith = (transitions: number): typeof RunStateSchema.Type => ({
  answers: { gate: transitions },
  asking: null,
  awaiting: [],
  capped: null,
  checkpoint: null,
  held: [],
  planVersion: 1,
  replies: [],
  revision: null,
  seeded: ["brief"],
  status: "running",
  transitions,
  value: null,
});

const planWith = (version: number): Plan => ({
  defaults: { agent: {} },
  envelope: {
    maxAgents: 10,
    maxDepth: 3,
    maxSteps: 50,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: `version ${version}`,
  id: "plan",
  machine: { id: "plan", initial: "end", states: { end: { type: "final" } } },
  version,
});

const openAll = (store: RunStore["Service"]) =>
  Effect.forEach(RUNS, (run) => store.open(run), { discard: true });

const apply = (store: RunStore["Service"], op: Op) => {
  switch (op.op) {
    case "doc": {
      return store.writeDoc(op.run, op.name, op.value);
    }

    case "replace": {
      return store.replaceDocs(op.run, op.docs);
    }

    case "journal": {
      return store.writeJournal(op.run, `logic:${op.key}`, op.value);
    }

    case "print": {
      return store.writeFingerprint(op.run, `logic:${op.key}`, op.print);
    }

    case "pause": {
      return store.writePaused(op.run, op.paused);
    }

    case "message": {
      return store.writeMessage(op.id, op.run);
    }

    case "state": {
      return store.writeRun(op.run, stateWith(op.transitions));
    }

    case "plan": {
      return store.writePlan(op.run, planWith(op.version));
    }

    case "commit": {
      return store.commit(op.run);
    }

    default: {
      return Effect.void;
    }
  }
};

const readAll = (store: RunStore["Service"]) =>
  Effect.all(
    RUNS.map((run) =>
      Effect.gen(function* readRun() {
        return {
          docs: yield* store.readDocs(run),
          journal: Object.fromEntries(yield* store.readJournal(run)),
          messages: yield* Effect.all(
            NAMES.map((id) =>
              store.readMessage(id).pipe(Effect.map(Option.getOrNull))
            )
          ),
          paused: yield* store.readPaused(run),
          plans: yield* Effect.all(
            [1, 2, 3].map((version) =>
              store.readPlan(run, version).pipe(Effect.map(Option.getOrNull))
            )
          ),
          prints: Object.fromEntries(yield* store.readFingerprints(run)),
          state: Option.getOrNull(yield* store.readRun(run)),
        };
      })
    )
  );

it.effect.prop(
  "the SQL store reads back exactly what the memory store does, and again after reopening the file",
  {
    ops: Arbitrary.schema(Schema.Array(OpSchema).check(Schema.isMaxLength(24))),
  },
  ({ ops }) =>
    Effect.gen(function* property() {
      const fs = yield* FileSystem.FileSystem;

      const file = (yield* Path.Path).join(
        yield* fs.makeTempDirectoryScoped(),
        "run.sqlite"
      );

      const model = yield* RunStore.pipe(
        Effect.provide(Layer.fresh(RunStore.memory))
      );

      yield* openAll(model);

      const store = yield* runStoreSql(nodeSqlStorage(file));

      yield* openAll(store);

      for (const op of ops) {
        yield* apply(model, op);
        yield* apply(store, op);
      }

      expect(yield* readAll(store)).toEqual(yield* readAll(model));

      for (const run of RUNS) {
        yield* model.commit(run);
        yield* store.commit(run);
      }

      const expected = yield* readAll(model);

      expect(yield* readAll(store)).toEqual(expected);
      expect(yield* readAll(yield* runStoreSql(nodeSqlStorage(file)))).toEqual(
        expected
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 300 }, timeout: 120_000 }
);

const crashingAt = (inner: SqlStorage, nth: number): SqlStorage => {
  let writes = 0;

  return {
    sql: {
      exec: (query, ...bindings) => {
        if (/^\s*(?:INSERT|DELETE)/u.test(query)) {
          writes += 1;

          if (writes === nth) {
            throw new Error("the process died inside the commit");
          }
        }

        return inner.sql.exec(query, ...bindings);
      },
    },
    transactionSync: inner.transactionSync,
  };
};

const Batch = Schema.Array(OpSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16)
);

it.effect.prop(
  "a commit that dies at any statement leaves the file exactly as the last commit did",
  {
    before: Arbitrary.schema(Batch),
    nth: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 1 }))
    ),
    torn: Arbitrary.schema(Batch),
  },
  ({ before, nth, torn }) =>
    Effect.gen(function* property() {
      const fs = yield* FileSystem.FileSystem;

      const file = (yield* Path.Path).join(
        yield* fs.makeTempDirectoryScoped(),
        "run.sqlite"
      );

      const first = yield* runStoreSql(nodeSqlStorage(file));

      yield* openAll(first);

      for (const op of before) {
        yield* apply(first, op);
      }

      for (const run of RUNS) {
        yield* first.commit(run);
      }

      const reread = Effect.suspend(() =>
        runStoreSql(nodeSqlStorage(file)).pipe(Effect.flatMap(readAll))
      );

      let committed = yield* reread;

      const dying = yield* runStoreSql(crashingAt(nodeSqlStorage(file), nth));

      yield* openAll(dying);

      for (const op of [...torn, { op: "commit", run: "one" } as const]) {
        const exit = yield* Effect.exit(apply(dying, op));

        if (Exit.isFailure(exit)) {
          expect(yield* reread, "a commit that died wrote nothing").toEqual(
            committed
          );

          return;
        }

        if (op.op === "commit") {
          committed = yield* reread;
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 300 }, timeout: 120_000 }
);
