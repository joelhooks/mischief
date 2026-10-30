import { expect, it } from "@effect/vitest";
import type { UnitProps } from "@rat-king/alchemy-nest";
import { Effect } from "effect";

import {
  peonProxyUnit,
  workspaceBridgeUnit,
} from "../workspace-bridge-unit.js";

const lines = (unit: UnitProps) =>
  unit.sections.flatMap((section) => section.lines);

it.effect(
  "workspace services keep separate private environment files and user-unit identities",
  () =>
    Effect.sync(() => {
      const bridge = workspaceBridgeUnit(
        { home: "/home/fixture" },
        "/opt/mischief/workspace-bridge/dist/main.js"
      );

      const proxy = peonProxyUnit(
        { home: "/home/fixture" },
        "/opt/mischief/workspace-bridge/dist/proxy-main.js"
      );

      expect(bridge.name).toBe("mischief-workspace-bridge.service");
      expect(proxy.name).toBe("mischief-peon-proxy.service");
      expect([bridge.scope, proxy.scope]).toEqual(["user", "user"]);
      expect(lines(bridge)).toContainEqual([
        "EnvironmentFile",
        "/home/fixture/.config/mischief/workspace-bridge.env",
      ]);
      expect(lines(proxy)).toContainEqual([
        "EnvironmentFile",
        "/home/fixture/.config/mischief/peon-proxy.env",
      ]);
      expect(lines(bridge)).toContainEqual(["KillMode", "control-group"]);
      expect(lines(proxy)).toContainEqual(["NoNewPrivileges", "true"]);
    })
);
