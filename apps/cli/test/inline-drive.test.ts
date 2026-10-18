import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { RunHost, RunStore } from "@mischief/core";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { localRunLayer } from "../src/run-layer.js";
import { runStoreFile } from "../src/run-store-file.js";

const planOf = (length: number) => ({
  defaults: { agent: {} },
  envelope: {
    maxAgents: length,
    maxDepth: 2,
    maxSteps: 20,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "A local submit owns its in-process driver until it stops",
  id: "local-drive",
  machine: {
    id: "local-drive",
    initial: "s0",
    states: {
      ...Object.fromEntries(
        Array.from({ length }).map((_, index) => [
          `s${index}`,
          {
            meta: {
              step: {
                kind: "think",
                prompt: `work ${index}`,
                writes: `doc-${index}`,
              },
            },
            on: {
              done: { target: index + 1 === length ? "end" : `s${index + 1}` },
            },
          },
        ])
      ),
      end: { type: "final" },
    },
  },
});

it.live.prop(
  "a local CLI submit finishes in-process and never leaves a stored running run without a driver",
  {
    length: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 }))
    ),
  },
  ({ length }) =>
    Effect.gen(function* localSubmit() {
      const root =
        yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();

      const host = yield* RunHost.pipe(
        Effect.provide(
          localRunLayer.pipe(
            Layer.provide(NodeCrypto.layer),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  HOME: root,
                  MISCHIEF_MODEL: "faux",
                  MISCHIEF_RUNS: root,
                })
              )
            )
          )
        )
      );

      const report = yield* host.submit("local", planOf(length));
      expect(report.status).toBe("done");
      expect(Object.keys(report.docs)).toHaveLength(length);

      const stored = yield* RunStore.use((store) =>
        store.readRun("local")
      ).pipe(Effect.provide(runStoreFile(root)));

      expect(stored.pipe(Option.map(({ status }) => status))).toEqual(
        Option.some("done")
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 10 }, timeout: 30_000 }
);
