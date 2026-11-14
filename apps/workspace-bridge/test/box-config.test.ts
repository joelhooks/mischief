import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer } from "effect";
import * as Digest from "effect/crypto/Digest";

import { boxStorageFromConfig } from "../src/box/config.js";
import { Boxes } from "../src/box/manager.js";
import { Runner } from "../src/runner.js";
import { image } from "./fixtures.js";

it.effect(
  "missing host storage paths are all named instead of selecting an unintended directory",
  () =>
    Effect.gen(function* missingPaths() {
      const missing = yield* Effect.flip(
        boxStorageFromConfig.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))
        )
      );

      for (const name of [
        "MISCHIEF_BOX_ROOT",
        "MISCHIEF_BOX_SNAPSHOTS",
        "MISCHIEF_BOX_METADATA",
        "MISCHIEF_BOX_MOUNT",
      ]) {
        expect(missing.message).toContain(name);
      }

      expect(missing.message).toContain("unintended host directory");

      const configured = {
        MISCHIEF_BOX_MOUNT: "/srv/example",
        MISCHIEF_BOX_METADATA: "/srv/example/metadata",
        MISCHIEF_BOX_ROOT: "/srv/example/boxes",
        MISCHIEF_BOX_SNAPSHOTS: "/srv/example/snapshots",
      };

      expect(
        yield* boxStorageFromConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromEnvRecord(configured))
          )
        )
      ).toEqual({
        metadata: "/srv/example/metadata",
        mount: "/srv/example",
        root: "/srv/example/boxes",
        snapshots: "/srv/example/snapshots",
      });

      const partial = yield* Effect.flip(
        boxStorageFromConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnvRecord({
                ...configured,
                MISCHIEF_BOX_ROOT: " ",
              })
            )
          )
        )
      );

      expect(partial.message).toContain("MISCHIEF_BOX_ROOT");
      expect(partial.message).not.toContain("MISCHIEF_BOX_METADATA");
    })
);

it.effect(
  "overlapping host roots fail before a hibernate or delete can erase another partition",
  () =>
    Effect.gen(function* partitions() {
      const fs = yield* FileSystem.FileSystem;

      const temporary = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".box-config-test-",
      });

      const root = `${temporary}/boxes`;

      for (const metadata of [root, `${root}/metadata`]) {
        const failure = yield* Effect.flip(
          Boxes.use(({ inspect }) => inspect("peon")).pipe(
            Effect.provide(
              Boxes.layer({
                gid: 1000,
                image,
                metadata,
                mount: temporary,
                mirrors: {},
                root,
                snapshots: `${temporary}/snapshots`,
              })
            ),
            Effect.provideService(
              Runner,
              Runner.of({
                run: () =>
                  Effect.die(
                    "Partition validation must not invoke a host command"
                  ),
              })
            )
          )
        );

        expect(failure.message).toContain("storage roots overlap");
        expect(yield* fs.exists(root)).toBe(false);
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, Digest.layerWebCrypto))
    )
);
