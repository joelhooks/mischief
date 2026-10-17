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
  "concurrent doc, journal and fingerprint writes to one run, committed while others write, all survive and read back in a fresh store",
  { names: NamesArbitrary },
  ({ names }) =>
    Effect.gen(function* property() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();

      yield* Effect.gen(function* writeConcurrently() {
        const store = yield* RunStore;

        yield* store.open("run");

        yield* Effect.forEach(
          names,
          (name) =>
            Effect.all(
              [
                store.writeDoc("run", name, name),
                store.writeJournal("run", `logic:${name}`, name),
                store.writeFingerprint("run", `logic:${name}`, `print ${name}`),
                store.commit("run"),
              ],
              { concurrency: "unbounded" }
            ),
          { concurrency: "unbounded", discard: true }
        );
        yield* store.commit("run");
      }).pipe(Effect.provide(runStoreFile(root)));

      const read = yield* Effect.gen(function* readFresh() {
        const store = yield* RunStore;

        return {
          docs: yield* store.readDocs("run"),
          fingerprints: Object.fromEntries(
            yield* store.readFingerprints("run")
          ),
          journal: Object.fromEntries(yield* store.readJournal("run")),
          other: (yield* store.readFingerprints("other")).size,
        };
      }).pipe(Effect.provide(runStoreFile(root)));

      expect(read).toEqual({
        docs: Object.fromEntries(names.map((name) => [name, name])),
        fingerprints: Object.fromEntries(
          names.map((name) => [`logic:${name}`, `print ${name}`])
        ),
        journal: Object.fromEntries(
          names.map((name) => [`logic:${name}`, name])
        ),
        other: 0,
      });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
  { arbitrary: { runs: 60 }, timeout: 20_000 }
);
