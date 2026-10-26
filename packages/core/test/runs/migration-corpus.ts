import { gunzipSync } from "node:zlib";

import { NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";

import { CorpusDecodeError } from "./corpus-decode-error.js";
import { MigrationCorpusSchema } from "./migration-support.js";

const corpusPath = "test/runs/fixtures/alpha65/runs.json.gz";

const gunzipCorpus = (bytes: Uint8Array) =>
  Effect.try({
    catch: (cause) =>
      new CorpusDecodeError({ path: corpusPath, reason: String(cause) }),
    try: () => gunzipSync(bytes).toString("utf-8"),
  });

export class MigrationCorpus extends Context.Service<
  MigrationCorpus,
  typeof MigrationCorpusSchema.Type
>()("test/MigrationCorpus") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* readCorpus() {
      const fs = yield* FileSystem.FileSystem;

      const source = yield* fs
        .readFile(corpusPath)
        .pipe(Effect.flatMap(gunzipCorpus));

      return yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(MigrationCorpusSchema)
      )(source);
    }).pipe(Effect.orDie)
  ).pipe(Layer.provide(NodeServices.layer));
}
