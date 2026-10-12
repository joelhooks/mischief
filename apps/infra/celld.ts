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
import { Config, Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/http";

import { callersFromConfig } from "./callers.ts";
import { buildWorker, INSTANCE } from "./celld-build.ts";

export const PORT_BASE = 28_000;

export const DATA_ROOT = "/data/joel/mischief";

export const UNIT_LIMITS = {
  celld: { cpuQuota: "100%", memoryMax: "1.5G", oomPolicy: "continue" },
  seaweed: {
    cpuQuota: "100%",
    memoryMax: "2G",
    oomPolicy: "continue",
    volumeMax: 32,
  },
  slice: { cpuQuota: "100%", memoryHigh: "2.5G", memoryMax: "3G" },
} as const;

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

      const mailbox = {
        did: yield* Config.String("MISCHIEF_MAILBOX_DID"),
        url: yield* Config.String("MISCHIEF_MAILBOX_URL"),
      };

      const bindingsFile = yield* Config.option(
        Config.String("MISCHIEF_BINDINGS_FILE")
      );

      const judge = yield* Config.Literals(
        ["jev", "shadow"],
        "MISCHIEF_JUDGE"
      ).pipe(Config.withDefault("shadow" as const));

      const prepared = yield* buildWorker({
        callers,
        commit,
        did,
        judge,
        mailbox,
        version,
      });

      const slice = yield* ObjectStore.Slice({
        ...UNIT_LIMITS.slice,
        home: host.home,
        instance: INSTANCE,
      });

      const bucket = yield* ObjectStore.Bucket("store", {
        ...UNIT_LIMITS.seaweed,
        dataRoot: DATA_ROOT,
        host,
        instance: INSTANCE,
        name: "mischief-cells",
        portBase: PORT_BASE,
        purgeOnDelete: false,
        slice: slice.sha256,
      });

      const cells = yield* Celld.Node("celld", {
        ...UNIT_LIMITS.celld,
        bucket,
        host,
        instance: INSTANCE,
        portBase: PORT_BASE,
        purgeOnDelete: false,
        workerIPv4: host.tailnetIPv4,
      });

      const [worker, configuration] = yield* stageDeploymentFiles(
        host.home,
        prepared,
        Option.isNone(bindingsFile),
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
                ...Option.match(bindingsFile, {
                  onNone: () => ({}),
                  onSome: (file) => ({
                    bindingsFile: file,
                    secretNames: ["MISCHIEF_IDENTITY", "MISCHIEF_JEV_KEY"],
                  }),
                }),
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
