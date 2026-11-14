import { expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Option } from "effect";

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
              MISCHIEF_BOX_MOUNT: "/srv/peon-volume",
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

        expect(units).toMatchSnapshot();
        expect(
          units[0]?.sections.find(({ name }) => name === "Unit")?.lines
        ).toContainEqual(["ConditionPathIsMountPoint", "/srv/peon-volume"]);
        expect(
          units[1]?.sections.find(({ name }) => name === "Unit")?.lines
        ).not.toContainEqual(["ConditionPathIsMountPoint", "/srv/peon-volume"]);

        for (const unit of units) {
          const lines = unit.sections.flatMap((section) => section.lines);
          expect(unit.scope).toBe("user");
          expect(lines).toContainEqual(["KillMode", "control-group"]);
          expect(lines).toContainEqual(["SuccessExitStatus", "130"]);
          expect(lines).toContainEqual(["NoNewPrivileges", "true"]);
          expect(lines).toContainEqual([
            "UMask",
            unit.name === "mischief-peon-boxes.service" ? "0007" : "0077",
          ]);
          expect(lines).toContainEqual([
            "EnvironmentFile",
            `/home/fixture/.config/mischief/${unit.name.replace("mischief-", "").replace(".service", "")}.env`,
          ]);
        }
      }
    })
);

it.effect(
  "enabled box units refuse a missing or unsafe mount gate instead of risking the shared disk",
  () =>
    Effect.gen(function* refusedMounts() {
      for (const mount of [
        undefined,
        "",
        "relative",
        "/",
        "/srv/../disk",
        "/srv/a\n[Service]",
        "/srv/%h",
      ]) {
        const entries = {
          MISCHIEF_BOX_ENTRY: "/opt/mischief/box-main.js",
          MISCHIEF_PEON_BOXES: "on",
          MISCHIEF_PEON_FULL_PROXY_ENTRY: "/opt/mischief/full-proxy-main.js",
        };

        const configuration =
          mount === undefined
            ? entries
            : { ...entries, MISCHIEF_BOX_MOUNT: mount };

        const result = yield* peonBoxesFromConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromEnvRecord(configuration))
          ),
          Effect.exit
        );

        expect(Exit.isFailure(result)).toBe(true);

        if (Exit.isFailure(result)) {
          expect(Cause.pretty(result.cause)).toContain("MISCHIEF_BOX_MOUNT");
          expect(Cause.pretty(result.cause)).toContain("shared root disk");
          expect(Cause.pretty(result.cause)).toContain("infra:plan");
        }
      }
    })
);
