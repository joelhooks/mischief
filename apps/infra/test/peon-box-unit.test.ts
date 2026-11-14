import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";

import { peonBoxesFromConfig } from "../peon-box-config.js";
import { peonBoxUnits } from "../peon-box-unit.js";

it.effect(
  "box units stay absent by default and use separate private host environment files only when enabled",
  () =>
    Effect.gen(function* unitConfig() {
      const disabled = yield* peonBoxesFromConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))
      );

      expect(disabled).toEqual(Option.none());

      const enabled = yield* peonBoxesFromConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              MISCHIEF_BOX_ENTRY: "/opt/mischief/box-main.js",
              MISCHIEF_PEON_BOXES: "on",
              MISCHIEF_PEON_FULL_PROXY_ENTRY:
                "/opt/mischief/full-proxy-main.js",
            })
          )
        )
      );

      expect(Option.isSome(enabled)).toBe(true);

      if (Option.isSome(enabled)) {
        const units = peonBoxUnits({ home: "/home/fixture" }, enabled.value);
        expect(units.map((unit) => unit.name)).toEqual([
          "mischief-peon-boxes.service",
          "mischief-peon-full-proxy.service",
        ]);

        for (const unit of units) {
          const lines = unit.sections.flatMap((section) => section.lines);
          expect(unit.scope).toBe("user");
          expect(lines).toContainEqual(["KillMode", "control-group"]);
          expect(lines).toContainEqual(["NoNewPrivileges", "true"]);
          expect(lines).toContainEqual(["UMask", "0077"]);
          expect(lines).toContainEqual([
            "EnvironmentFile",
            `/home/fixture/.config/mischief/${unit.name.replace("mischief-", "").replace(".service", "")}.env`,
          ]);
        }
      }
    })
);
