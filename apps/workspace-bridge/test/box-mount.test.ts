import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import * as Digest from "effect/crypto/Digest";

import { Boxes } from "../src/box/manager.js";
import { Runner } from "../src/runner.js";
import { image } from "./fixtures.js";

it.effect(
  "storage cannot create directories outside the capped volume or through a symlink",
  () =>
    Effect.gen(function* mountBoundary() {
      const fs = yield* FileSystem.FileSystem;

      const temporary = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".box-mount-test-",
      });

      const mount = `${temporary}/volume`;
      yield* fs.makeDirectory(mount);
      yield* fs.makeDirectory(`${temporary}/outside`);
      yield* fs.symlink(`${temporary}/outside`, `${mount}/link`);

      const storage = {
        metadata: `${mount}/metadata`,
        root: `${mount}/boxes`,
        snapshots: `${mount}/snapshots`,
      };

      for (const directory of [
        `${temporary}/outside/new`,
        `${mount}-sibling/new`,
        `${mount}/../outside/new`,
        `${mount}/link/new`,
      ]) {
        for (const field of Object.keys(storage)) {
          const failure = yield* Effect.flip(
            Boxes.use(({ inspect }) => inspect("peon")).pipe(
              Effect.provide(
                Boxes.layer({
                  gid: 1000,
                  image,
                  ...storage,
                  [field]: directory,
                  mirrors: {},
                  mount,
                })
              ),
              Effect.provideService(
                Runner,
                Runner.of({
                  run: () =>
                    Effect.die("Unsafe storage must not invoke Docker"),
                })
              )
            )
          );

          expect(failure.message).toMatch(
            /capped volume|absolute and canonical/u
          );
          expect(yield* fs.exists(directory)).toBe(false);

          for (const safe of Object.values(storage)) {
            expect(yield* fs.exists(safe)).toBe(false);
          }
        }
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, Digest.layerWebCrypto))
    )
);
