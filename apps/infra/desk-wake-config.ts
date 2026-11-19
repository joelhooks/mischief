import type { UnitProps } from "@rat-king/alchemy-nest";
import { Config, Effect } from "effect";

import { quoteUnitArgument } from "./opus-bridge-unit.ts";

export const deskWakeFromConfig = Effect.gen(function* deskWakeConfig() {
  const flag = yield* Config.Literals(["off", "on"], "MISCHIEF_DESK_WAKE").pipe(
    Config.withDefault("off")
  );

  if (flag !== "on") {
    return null;
  }

  return {
    entry: yield* Config.NonEmptyString("MISCHIEF_DESK_HOST_ENTRY"),
    sender: yield* Config.NonEmptyString("MISCHIEF_DESK_WAKE_SENDER"),
  };
});

export const deskHostUnit = (
  host: { readonly home: string },
  entry: string
): UnitProps => ({
  home: host.home,
  name: "mischief-desk-host.service",
  scope: "user",
  sections: [
    { lines: [["Description", "Mischief desk restore host"]], name: "Unit" },
    {
      lines: [
        ["EnvironmentFile", `${host.home}/.config/mischief/desk-host.env`],
        ["ExecStart", `/usr/local/bin/node ${quoteUnitArgument(entry)}`],
        ["MemoryMax", "512M"],
        ["NoNewPrivileges", "true"],
        ["Restart", "on-failure"],
        ["RestartSec", "10"],
        ["TasksMax", "64"],
        ["Type", "simple"],
        ["UMask", "0077"],
      ],
      name: "Service",
    },
    { lines: [["WantedBy", "default.target"]], name: "Install" },
  ],
});
