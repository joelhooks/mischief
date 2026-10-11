import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { probeLabels } from "../celld-ops.ts";

const PORTS = [28_000, 28_001, 28_009];

const Host = Schema.Struct({
  listening: Schema.Array(
    Schema.Struct({
      host: Schema.Literals([
        "127.0.0.1",
        "0.0.0.0",
        "[::]",
        "*",
        "100.64.0.7",
      ]),
      port: Schema.Literals([2800, 28_000, 28_001, 28_009, 28_010, 28_081]),
    })
  ),
  paths: Schema.Array(
    Schema.Struct({
      path: Schema.Literals(["/config", "/bin", "/data"]),
      present: Schema.Boolean,
    })
  ),
  units: Schema.Array(
    Schema.Literals([
      "mischief.slice",
      "mischief-celld.service",
      "mischief-storage-retention.timer",
    ])
  ),
});

it.effect.prop(
  "the teardown probe names every unit, path and instance port still on the host, and nothing else",
  { host: Arbitrary.schema(Host) },
  ({ host }) =>
    Effect.sync(() => {
      const labels = probeLabels({
        listeners: host.listening
          .map(
            ({ host: address, port }) =>
              `LISTEN 0      4096   ${address}:${port}   0.0.0.0:${port === 28_000 ? 28_009 : 443}`
          )
          .join("\n"),
        paths: host.paths.map(({ path, present }) => [
          path,
          present ? { type: "Directory" } : undefined,
        ]),
        ports: PORTS,
        units: host.units.map((unit) => `${unit} enabled enabled`).join("\n"),
      });

      expect(labels).toStrictEqual([
        { check: "UNITS_ABSENT", remaining: [...host.units] },
        {
          check: "PATHS_ABSENT",
          remaining: host.paths.flatMap(({ path, present }) =>
            present ? [path] : []
          ),
        },
        {
          check: "LISTENERS_ABSENT",
          remaining: PORTS.flatMap((port) =>
            host.listening.some((entry) => entry.port === port)
              ? [`port ${port}`]
              : []
          ),
        },
      ]);
    }),
  { arbitrary: { runs: 300 } }
);
