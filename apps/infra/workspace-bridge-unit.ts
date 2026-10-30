import type { UnitProps } from "@rat-king/alchemy-nest";

import { opusBridgeUnit } from "./opus-bridge-unit.js";

const unit = (
  host: { readonly home: string },
  entry: string,
  name: string,
  description: string,
  environment: string
): UnitProps => ({
  home: host.home,
  name,
  scope: "user",
  sections: [
    { lines: [["Description", description]], name: "Unit" },
    {
      lines: opusBridgeUnit(host, entry)
        .sections.flatMap((section) =>
          section.name === "Service" ? section.lines : []
        )
        .map(([key, value]): readonly [string, string] => [
          key,
          key === "EnvironmentFile"
            ? `${host.home}/.config/mischief/${environment}.env`
            : value,
        ]),
      name: "Service",
    },
    { lines: [["WantedBy", "default.target"]], name: "Install" },
  ],
});

export const workspaceBridgeUnit = (
  host: { readonly home: string },
  entry: string
): UnitProps =>
  unit(
    host,
    entry,
    "mischief-workspace-bridge.service",
    "Mischief read-only workspace bridge",
    "workspace-bridge"
  );

export const peonProxyUnit = (
  host: { readonly home: string },
  entry: string
): UnitProps =>
  unit(
    host,
    entry,
    "mischief-peon-proxy.service",
    "Mischief peon Messages proxy",
    "peon-proxy"
  );
