import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { buildWorker } from "../celld-build.ts";
import { opusBridgeUnit, renderOpusBridgeUnit } from "../units.ts";

it.effect(
  "an enabled bridge URL reaches the built worker without putting the bearer key in deployment vars",
  () =>
    Effect.gen(function* configuredWorker() {
      const prepared = yield* buildWorker({
        callers: "[]",
        commit: "0123456",
        did: "did:web:mischief.example.invalid",
        judge: "shadow",
        mailbox: {
          did: "did:web:mailbox.example.invalid",
          url: "http://mailbox.invalid",
        },
        opusBridgeUrl: "http://127.0.0.1:28010/v1",
        thinker: { model: "cliproxy", url: "https://cliproxy.invalid/v1" },
        version: "0.1.0",
      });

      const configuration = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({ vars: Schema.Record(Schema.String, Schema.String) })
        )
      )(prepared.configuration);

      expect(configuration.vars.MISCHIEF_OPUS_BRIDGE_URL).toBe(
        "http://127.0.0.1:28010/v1"
      );
      expect(configuration.vars.MISCHIEF_OPUS_BRIDGE_KEY).toBeUndefined();
      expect(configuration.vars.MISCHIEF_CLIPROXY_URL).toBe(
        "https://cliproxy.invalid/v1"
      );
      expect(prepared.bundle).not.toMatch(/from "node:/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000
);

it.effect(
  "the optional user unit uses a private EnvironmentFile, caps its own memory and kills its process group without changing celld's slice",
  () =>
    Effect.sync(() => {
      const host = { home: "/home/operator" };
      const entry = "/home/operator/opus-bridge/dist/main.js";
      const unit = opusBridgeUnit(host, entry);

      const sections = Object.fromEntries(
        unit.sections.map(({ lines, name }) => [
          name,
          Object.fromEntries(lines),
        ])
      );

      expect(unit.name).toBe("mischief-opus-bridge.service");
      expect(sections.Service).toMatchObject({
        EnvironmentFile: '"/home/operator/.config/mischief/opus-bridge.env"',
        ExecStart: `/usr/local/bin/node "${entry}"`,
        KillMode: "control-group",
        MemoryHigh: "3.5G",
        MemoryMax: "4G",
        MemorySwapMax: "0",
        UMask: "0077",
      });
      expect(sections.Service).not.toHaveProperty("Slice");
      expect(sections.Service).not.toHaveProperty("Environment");
      expect(renderOpusBridgeUnit(host, entry).path).toBe(
        "/home/operator/.config/systemd/user/mischief-opus-bridge.service"
      );
    })
);
