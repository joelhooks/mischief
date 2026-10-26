import { NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";

import { MigrationCorpusSchema } from "./migration-support.js";

export class MigrationCorpus extends Context.Service<
  MigrationCorpus,
  typeof MigrationCorpusSchema.Type
>()("test/MigrationCorpus") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* readCorpus() {
      const fs = yield* FileSystem.FileSystem;

      const source = yield* fs.readFileString(
        "test/runs/fixtures/alpha65/runs.json"
      );

      return yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(MigrationCorpusSchema)
      )(source);
    }).pipe(Effect.orDie)
  ).pipe(Layer.provide(NodeServices.layer));
}
