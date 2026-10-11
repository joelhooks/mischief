import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { RunStore } from "@mischief/core";
import { Effect, FileSystem, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { runStoreFile } from "../src/run-store-file.js";

const NamesArbitrary = Arbitrary.array(
  Arbitrary.schema(
    Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{0,7}$/u))
  ),
  { maxLength: 12, minLength: 2 }
);

it.effect.prop(
  "concurrent doc and journal writes to one run all survive",
  { names: NamesArbitrary },
  ({ names }) =>
    Effect.gen(function* property() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();

      const docs = yield* Effect.gen(function* writeConcurrently() {
        const store = yield* RunStore;

        yield* Effect.forEach(
          names,
          (name) =>
            Effect.all(
              [
                store.writeDoc("run", name, name),
                store.writeJournal("run", `logic:${name}`, name),
              ],
              { concurrency: "unbounded" }
            ),
          { concurrency: "unbounded", discard: true }
        );

        return {
          docs: yield* store.readDocs("run"),
          journal: Object.fromEntries(yield* store.readJournal("run")),
        };
      }).pipe(Effect.provide(runStoreFile(root)));

      expect(docs).toEqual({
        docs: Object.fromEntries(names.map((name) => [name, name])),
        journal: Object.fromEntries(
          names.map((name) => [`logic:${name}`, name])
        ),
      });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
  { arbitrary: { runs: 60 }, timeout: 20_000 }
);
