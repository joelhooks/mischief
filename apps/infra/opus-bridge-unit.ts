import type { UnitProps } from "@rat-king/alchemy-nest";

const quote = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;

export const opusBridgeUnit = (
  host: { readonly home: string },
  entry: string
): UnitProps => ({
  home: host.home,
  name: "mischief-opus-bridge.service",
  scope: "user",
  sections: [
    { lines: [["Description", "Mischief Opus review bridge"]], name: "Unit" },
    {
      lines: [
        [
          "EnvironmentFile",
          quote(`${host.home}/.config/mischief/opus-bridge.env`),
        ],
        ["ExecStart", `/usr/local/bin/node ${quote(entry)}`],
        ["KillMode", "control-group"],
        ["MemoryHigh", "3.5G"],
        ["MemoryMax", "4G"],
        ["MemorySwapMax", "0"],
        ["NoNewPrivileges", "true"],
        ["Restart", "on-failure"],
        ["RestartSec", "10"],
        ["TimeoutStopSec", "10"],
        ["Type", "simple"],
        ["UMask", "0077"],
      ],
      name: "Service",
    },
    { lines: [["WantedBy", "default.target"]], name: "Install" },
  ],
});

export const renderOpusBridgeUnit = (
  host: { readonly home: string },
  entry: string
) => {
  const unit = opusBridgeUnit(host, entry);

  return {
    path: `${host.home}/.config/systemd/user/${unit.name}`,
    text: `${unit.sections.map(({ lines, name }) => `[${name}]\n${lines.map(([key, value]) => `${key}=${value}`).join("\n")}`).join("\n\n")}\n`,
  };
};
