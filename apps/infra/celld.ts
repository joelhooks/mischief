import {
  Celld,
  HostDirectoryProvider,
  ObjectStore,
  RatsNest,
  RemoteFileProvider,
  sourceLayer,
  stageDeploymentFiles,
} from "@rat-king/alchemy-nest";
import type { DeploymentProps, HostShell } from "@rat-king/alchemy-nest";
import { localState, Stack } from "alchemy";
import * as Output from "alchemy/Output";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import { callersFromConfig } from "./callers.ts";
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

      const { callers, did } = yield* callersFromConfig;

      const prepared = yield* buildWorker({ callers, commit, did, version });

      const slice = yield* ObjectStore.Slice({
        cpuQuota: "100%",
        home: host.home,
        instance: INSTANCE,
        memoryHigh: "2.5G",
        memoryMax: "3G",
      });

      const bucket = yield* ObjectStore.Bucket("store", {
        cpuQuota: "100%",
        dataRoot: DATA_ROOT,
        host,
        instance: INSTANCE,
        memoryMax: "1.5G",
        name: "mischief-cells",
        oomPolicy: "continue",
        portBase: PORT_BASE,
        purgeOnDelete: true,
        slice: slice.sha256,
        volumeMax: 32,
      });

      const cells = yield* Celld.Node("celld", {
        bucket,
        cpuQuota: "100%",
        host,
        instance: INSTANCE,
        memoryMax: "1.5G",
        oomPolicy: "continue",
        portBase: PORT_BASE,
        purgeOnDelete: true,
        workerIPv4: host.tailnetIPv4,
      });

      const [worker, configuration] = yield* stageDeploymentFiles(
        host.home,
        prepared,
        true,
        cells.layout,
        bucket.configuration
      );

      const deployment = yield* Celld.Deployment(
        "planrun",
        Output.all(
          cells.publicUrl,
          cells.internalUrl,
          bucket.configuration,
          worker,
          configuration,
          cells.unit.sha256
        ).pipe(
          Output.map(
            ([workerUrl, internalUrl, configurationRoot]) =>
              ({
                ...prepared,
                binary: `${cells.layout.bin}/celld`,
                directory: `${configurationRoot}/deployment`,
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
