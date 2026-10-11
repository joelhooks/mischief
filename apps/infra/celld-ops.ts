import { NodeCrypto, NodeServices } from "@effect/platform-node";
import {
  instanceLayout,
  RatsNest,
  Ssh,
  startupLayer,
  HostShell,
} from "@rat-king/alchemy-nest";
import { Config, Effect, Layer } from "effect";

import { INSTANCE } from "./celld-build.ts";
import { DATA_ROOT, PORT_BASE } from "./celld.ts";

export const STAGE = "prototype";

const PORTS = Array.from({ length: 10 }, (_, offset) => PORT_BASE + offset);

export const liveNode = Effect.gen(function* liveNode() {
  const hosts = yield* RatsNest.Host;

  return yield* hosts.node(yield* Config.String("MISCHIEF_CELLD_NODE"));
}).pipe(Effect.provide(RatsNest.layer));

export const liveServices = Layer.unwrap(
  liveNode.pipe(
    Effect.map((node) => {
      const instance = {
        dataRoot: DATA_ROOT,
        instance: INSTANCE,
        portBase: PORT_BASE,
      };

      const shell = Ssh.layer(node, instance);

      return Layer.merge(
        shell,
        startupLayer(
          node.tailnetIPv4,
          "scope",
          undefined,
          undefined,
          instanceLayout(node, instance)
        ).pipe(Layer.provide(shell))
      );
    })
  )
).pipe(
  Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
  Layer.orDie
);

export interface ProbeLabel {
  readonly check: string;
  readonly passed: boolean;
}

export const teardownProbe = Effect.gen(function* teardownProbe() {
  const shell = yield* HostShell;
  const node = yield* liveNode;

  const layout = instanceLayout(node, {
    dataRoot: DATA_ROOT,
    instance: INSTANCE,
    portBase: PORT_BASE,
  });

  const units = yield* shell.exec([
    "systemctl",
    "--user",
    "list-unit-files",
    "--no-legend",
    "--plain",
    `${INSTANCE}*`,
    `${INSTANCE}.slice`,
  ]);

  const leftovers = yield* Effect.forEach(
    [layout.configuration, layout.binaryRoot, DATA_ROOT],
    (path) => shell.stat(path)
  );

  const listeners = yield* shell.exec(["ss", "-Hltn"]);

  const listening = listeners.stdout
    .split("\n")
    .some((line) => PORTS.some((port) => line.includes(`:${port} `)));

  return [
    { check: "UNITS_ABSENT", passed: units.stdout.trim() === "" },
    {
      check: "PATHS_ABSENT",
      passed: leftovers.every((entry) => entry === undefined),
    },
    { check: "LISTENERS_ABSENT", passed: !listening },
  ] satisfies readonly ProbeLabel[];
});
