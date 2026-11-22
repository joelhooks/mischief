import type { UnitProps } from "@rat-king/alchemy-nest";

import { opusBridgeUnit } from "./opus-bridge-unit.js";

export const peonBoxUnits = (
  host: { readonly home: string },
  config: {
    readonly archive: Readonly<Record<string, string>>;
    readonly boxEntry: string;
    readonly mount: string;
    readonly proxyEntry: string;
  }
): readonly UnitProps[] =>
  [
    {
      description: "Mischief full peon box manager",
      entry: config.boxEntry,
      environment: "peon-boxes",
      name: "mischief-peon-boxes.service",
    },
    {
      description: "Mischief full peon model proxy",
      entry: config.proxyEntry,
      environment: "peon-full-proxy",
      name: "mischief-peon-full-proxy.service",
    },
  ].map(({ entry, name, environment, description }): UnitProps => ({
    home: host.home,
    name,
    scope: "user",
    sections: [
      {
        lines: [
          ["Description", description],
          ...(name === "mischief-peon-boxes.service" ? [config.mount] : []).map(
            (mount): readonly [string, string] => [
              "ConditionPathIsMountPoint",
              mount,
            ]
          ),
        ],
        name: "Unit",
      },
      {
        lines: [
          ...opusBridgeUnit(host, entry)
            .sections.flatMap((section) =>
              section.name === "Service" ? section.lines : []
            )
            .map(([key, value]): readonly [string, string] => {
              if (key === "EnvironmentFile") {
                return [
                  key,
                  `${host.home}/.config/mischief/${environment}.env`,
                ];
              }

              if (key === "UMask" && name === "mischief-peon-boxes.service") {
                return [key, "0007"];
              }

              return [key, value];
            }),
          ...(environment === "peon-boxes"
            ? Object.entries(config.archive)
                .filter(([, value]) => value !== "")
                .map(([variable, value]): readonly [string, string] => [
                  "Environment",
                  `${variable}=${value}`,
                ])
            : []),
        ],
        name: "Service",
      },
      { lines: [["WantedBy", "default.target"]], name: "Install" },
    ],
  }));
