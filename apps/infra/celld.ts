import {
  Celld,
  HostDirectory,
  HostDirectoryProvider,
  ObjectStore,
  RatsNest,
  RemoteFile,
  RemoteFileProvider,
  sourceLayer,
} from "@rat-king/alchemy-nest";
import type { DeploymentProps, HostShell } from "@rat-king/alchemy-nest";
import { localState, Stack } from "alchemy";
import * as Output from "alchemy/Output";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import { buildWorker, INSTANCE } from "./celld-build.ts";

export const PORT_BASE = 28_000;

export const DATA_ROOT = "/data/joel/mischief";

export const celldStack = (hostServices: Layer.Layer<HostShell>) =>
  Stack(
    "mischief-celld",
    {
      providers: Layer.mergeAll(
        ObjectStore.providers(),
        Celld.providers(),
        Celld.deploymentProvider(),
        HostDirectoryProvider(),
        RemoteFileProvider()
      ).pipe(
        Layer.provide(hostServices),
        Layer.provide(sourceLayer.pipe(Layer.orDie)),
        Layer.provide(FetchHttpClient.layer)
      ),
      state: localState(),
    },
    Effect.gen(function* mischiefCelld() {
      const hosts = yield* RatsNest.Host;

      const host = yield* hosts
        .node(yield* Config.String("MISCHIEF_CELLD_NODE"))
        .pipe(Effect.orDie);

      const commit = yield* Config.String("MISCHIEF_COMMIT");
      const version = yield* Config.String("MISCHIEF_VERSION");

      const desk = yield* Config.String("MISCHIEF_DESK").pipe(
        Config.withDefault("mischief")
      );

      const prepared = yield* buildWorker({ commit, desk, version });

      const slice = yield* ObjectStore.Slice({
        cpuQuota: "100%",
        home: host.home,
        instance: INSTANCE,
        memoryHigh: "2.5G",
        memoryMax: "3G",
        oomPolicy: "continue",
      });

      const bucket = yield* ObjectStore.Bucket("store", {
        dataRoot: DATA_ROOT,
        host,
        instance: INSTANCE,
        name: "mischief-cells",
        portBase: PORT_BASE,
        slice: slice.sha256,
        volumeMax: 32,
      });

      const cells = yield* Celld.Node("celld", {
        bucket,
        host,
        instance: INSTANCE,
        portBase: PORT_BASE,
        workerIPv4: host.tailnetIPv4,
      });

      const staging = yield* HostDirectory("deployment-directory", {
        mode: 0o700,
        path: `${cells.layout.configuration}/deployment`,
      });

      const worker = yield* RemoteFile("deployment-worker", {
        content: prepared.bundle,
        mode: 0o600,
        path: Output.interpolate`${staging.path}/worker.mjs`,
      });

      const configuration = yield* RemoteFile("deployment-configuration", {
        content: prepared.configuration,
        mode: 0o600,
        path: Output.interpolate`${staging.path}/wrangler.json`,
      });

      const deployment = yield* Celld.Deployment(
        "planrun",
        Output.all(
          cells.publicUrl,
          cells.internalUrl,
          staging.path,
          worker.sha256,
          configuration.sha256,
          cells.unit.sha256
        ).pipe(
          Output.map(
            ([workerUrl, internalUrl, directory]) =>
              ({
                ...prepared,
                binary: `${cells.layout.bin}/celld`,
                directory,
                environmentFile: `${cells.layout.configuration}/celld.env`,
                internalUrl,
                workerUrl,
              }) satisfies DeploymentProps
          )
        )
      );

      return {
        commit: deployment.commit,
        version: deployment.version,
        workerUrl: deployment.workerUrl,
      };
    }).pipe(Effect.provide(RatsNest.layer), Effect.orDie)
  );
