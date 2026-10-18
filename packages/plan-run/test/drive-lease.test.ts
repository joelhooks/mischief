import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { withinRun } from "@mischief/core";
import { Effect, Exit, FileSystem, Option, Path, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { driveLease } from "../src/drive-lease.js";
import { nodeSqlStorage } from "../src/node-sql.js";
import { runStoreSql } from "../src/sql-store.js";

it.effect.prop(
  "an expired holder cannot write any run artifacts after a newer epoch takes over, or release the new holder",
  {
    current: Arbitrary.schema(Schema.String),
    stale: Arbitrary.schema(Schema.String),
    ttl: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 }))
    ),
  },
  ({ current, stale, ttl }) =>
    Effect.gen(function* fencedWrites() {
      const file = (yield* Path.Path).join(
        yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
        "lease.sqlite"
      );

      const storage = nodeSqlStorage(file);
      const lease = driveLease(storage);
      const first = Option.getOrThrow(lease.take("first", 0, ttl));
      const second = Option.getOrThrow(lease.take("second", ttl + 1, ttl));
      expect(second.epoch).toBe(first.epoch + 1);
      expect(lease.renew(first, ttl + 1, ttl)).toBe(false);
      const previous = yield* runStoreSql(lease.fenced(first));
      const present = yield* runStoreSql(lease.fenced(second));
      yield* withinRun(
        present,
        "run"
      )(
        Effect.gen(function* currentWrite() {
          yield* present.writeDoc("run", "current", current);
          yield* present.writeJournal("run", "current", current);
        })
      );

      const staleWrite = yield* withinRun(
        previous,
        "run"
      )(
        Effect.gen(function* staleWrite() {
          yield* previous.writeDoc("run", "stale", stale);
          yield* previous.writeJournal("run", "stale", stale);
        })
      ).pipe(Effect.exit);

      expect(Exit.isFailure(staleWrite)).toBe(true);
      expect(yield* present.readDocs("run")).toEqual({ current });
      expect(Object.fromEntries(yield* present.readJournal("run"))).toEqual({
        current,
      });
      lease.release(first);
      expect(lease.peek()).toEqual(second);
      expect(lease.take("third", ttl + 1, ttl)).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 40 }, timeout: 30_000 }
);
