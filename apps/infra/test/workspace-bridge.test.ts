import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { offlineLayer } from "@rat-king/alchemy-nest/offline";
import * as Output from "alchemy/Output";
import { inMemoryState } from "alchemy/State";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Schema,
} from "effect";

import { celldStack } from "../celld.ts";
import { reviewRows } from "../plan-review.ts";
import { planWith } from "../plan-runtime.ts";

const plannedWorkspace = Effect.fn("plannedWorkspace")(
  function* plannedWorkspace(configuration: Record<string, string>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const inventory = path.join(dir, "instance.json");
    const callers = path.join(dir, "callers.json");

    yield* fs.writeFileString(
      callers,
      JSON.stringify([
        {
          authentication: ["did:web:driver.ratking-fleet.invalid#atproto"],
          id: "did:web:driver.ratking-fleet.invalid",
          keyAgreement: [],
          verificationMethod: [
            {
              controller: "did:web:driver.ratking-fleet.invalid",
              id: "did:web:driver.ratking-fleet.invalid#atproto",
              publicKeyJwk: {
                crv: "P-256",
                kty: "EC",
                x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
                y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
              },
            },
          ],
        },
      ])
    );
    yield* fs.writeFileString(
      inventory,
      JSON.stringify({
        domains: ["example.test"],
        hosts: ["node"],
        ips: ["192.0.2.7"],
        nodes: {
          node: {
            dataRoot: "/data/planner",
            home: "/home/planner",
            ssh: "planner@node",
            tailnetIPv4: "192.0.2.7",
          },
        },
        secretNames: ["NONE"],
        sites: ["example"],
      }),
      { mode: 0o600 }
    );

    const plan = yield* planWith(
      celldStack(offlineLayer),
      false,
      inMemoryState(),
      "prototype"
    ).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            MISCHIEF_BINDINGS_FILE:
              "/home/planner/.config/mischief/bindings.json",
            MISCHIEF_CALLERS_FILE: callers,
            MISCHIEF_CELLD_NODE: "node",
            MISCHIEF_COMMIT: "0123456",
            MISCHIEF_DID: "did:web:mischief.example.invalid",
            MISCHIEF_MAILBOX_DID: "did:web:mailbox.example.invalid",
            MISCHIEF_MAILBOX_URL: "http://mailbox.example.invalid",
            MISCHIEF_VERSION: "0.1.0",
            RATS_NEST_INSTANCE: inventory,
            ...configuration,
          })
        )
      )
    );

    expect(Option.isSome(plan)).toBe(true);

    if (Option.isNone(plan)) {
      return [];
    }

    const rows = yield* reviewRows(plan.value).pipe(
      Effect.provide(NodeCrypto.layer)
    );

    const deployment = plan.value.resources.planrun;

    if (deployment !== undefined && "props" in deployment) {
      const resolved: unknown = yield* Output.evaluate(
        deployment.props,
        Object.fromEntries(
          Object.keys(plan.value.resources).map((fqn) => [
            fqn,
            { path: "/planned", sha256: "planned" },
          ])
        )
      ).pipe(Effect.provide(inMemoryState()));

      const props = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          bindingsFile: Schema.String,
          secretNames: Schema.Array(Schema.String),
        })
      )(resolved);

      return rows.map((row) =>
        row.fqn === "planrun" ? { ...row, props } : row
      );
    }

    return rows;
  }
);

const ConfigurationFile = Schema.Struct({ content: Schema.String });

const WorkerConfiguration = Schema.fromJsonString(
  Schema.Struct({
    vars: Schema.Record(Schema.String, Schema.String),
  })
);

const Unit = Schema.Struct({
  name: Schema.String,
  sections: Schema.Array(
    Schema.Struct({
      lines: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
      name: Schema.String,
    })
  ),
});

it.effect(
  "an empty workspace URL preserves the existing plan byte for byte, even with unused entries and repos",
  () =>
    Effect.gen(function* disabledWorkspace() {
      const disabled = yield* plannedWorkspace({
        MISCHIEF_PEON_PROXY_ENTRY: "/unused/proxy-main.js",
        MISCHIEF_WORKSPACE: "off",
        MISCHIEF_WORKSPACE_BRIDGE_ENTRY: "/unused/main.js",
        MISCHIEF_WORKSPACE_BRIDGE_URL: "",
        MISCHIEF_WORKSPACE_REPOS: "example/unused",
      });

      expect(disabled.map(({ fqn }) => fqn)).not.toContain("workspace-bridge");
      expect(disabled.map(({ fqn }) => fqn)).not.toContain("peon-proxy");
      expect(JSON.stringify(disabled)).not.toContain("MISCHIEF_WORKSPACE");
      const baseline = yield* plannedWorkspace({});
      expect(JSON.stringify(disabled)).toBe(JSON.stringify(baseline));
      expect(baseline).toMatchSnapshot();
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000
);

it.effect(
  "a configured workspace URL declares both units and delivers worker vars and the private binding name",
  () =>
    Effect.gen(function* enabledWorkspace() {
      const rows = yield* plannedWorkspace({
        MISCHIEF_PEON_PROXY_ENTRY: "/opt/workspace-bridge/dist/proxy-main.js",
        MISCHIEF_WORKSPACE: "on",
        MISCHIEF_WORKSPACE_BRIDGE_ENTRY: "/opt/workspace-bridge/dist/main.js",
        MISCHIEF_WORKSPACE_BRIDGE_URL: "http://127.0.0.1:28011/v1/responses",
        MISCHIEF_WORKSPACE_REPOS: "example/repo",
      });

      for (const [fqn, entry] of [
        ["workspace-bridge", "main.js"],
        ["peon-proxy", "proxy-main.js"],
      ]) {
        const unit = yield* Schema.decodeUnknownEffect(Unit)(
          rows.find((row) => row.fqn === fqn)?.props
        );

        expect(unit.name).toBe(`mischief-${fqn}.service`);

        const sections = Object.fromEntries(
          unit.sections.map(({ name, lines }) => [
            name,
            Object.fromEntries(lines),
          ])
        );

        expect(sections.Service).toMatchObject({
          EnvironmentFile: `/home/planner/.config/mischief/${fqn}.env`,
          ExecStart: `/usr/local/bin/node "/opt/workspace-bridge/dist/${entry}"`,
        });
      }

      const file = yield* Schema.decodeUnknownEffect(ConfigurationFile)(
        rows.find(
          ({ fqn }) => fqn === "mischief-deployment-stage-configuration"
        )?.props
      );

      const { vars } = yield* Schema.decodeUnknownEffect(WorkerConfiguration)(
        file.content
      );

      expect(vars).toMatchObject({
        MISCHIEF_WORKSPACE: "on",
        MISCHIEF_WORKSPACE_BRIDGE_URL: "http://127.0.0.1:28011/v1/responses",
        MISCHIEF_WORKSPACE_REPOS: "example/repo",
      });
      expect(vars).not.toHaveProperty("MISCHIEF_WORKSPACE_BRIDGE_KEY");
      const deployment = rows.find(({ fqn }) => fqn === "planrun");
      expect(deployment?.props).toMatchObject({
        bindingsFile: "/home/planner/.config/mischief/bindings.json",
        secretNames: [
          "MISCHIEF_IDENTITY",
          "MISCHIEF_JEV_KEY",
          "MISCHIEF_WORKSPACE_BRIDGE_KEY",
        ],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000
);

it.effect(
  "provisioning the workspace bridge leaves workspace execution off unless explicitly enabled",
  () =>
    Effect.gen(function* provisionedWorkspace() {
      const rows = yield* plannedWorkspace({
        MISCHIEF_PEON_PROXY_ENTRY: "/opt/workspace-bridge/dist/proxy-main.js",
        MISCHIEF_WORKSPACE_BRIDGE_ENTRY: "/opt/workspace-bridge/dist/main.js",
        MISCHIEF_WORKSPACE_BRIDGE_URL: "http://127.0.0.1:28011/v1/responses",
      });

      expect(rows.map(({ fqn }) => fqn)).toEqual(
        expect.arrayContaining(["workspace-bridge", "peon-proxy"])
      );

      const file = yield* Schema.decodeUnknownEffect(ConfigurationFile)(
        rows.find(
          ({ fqn }) => fqn === "mischief-deployment-stage-configuration"
        )?.props
      );

      const { vars } = yield* Schema.decodeUnknownEffect(WorkerConfiguration)(
        file.content
      );

      expect(vars.MISCHIEF_WORKSPACE).toBe("off");
      expect(vars.MISCHIEF_WORKSPACE_REPOS).toBe("");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000
);

it.effect(
  "workspace on without a bridge URL refuses routing work to nowhere and names the fix",
  () =>
    Effect.gen(function* refusedWorkspace() {
      const result = yield* plannedWorkspace({ MISCHIEF_WORKSPACE: "on" }).pipe(
        Effect.exit
      );

      expect(Exit.isFailure(result)).toBe(true);

      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain(
          "routes workspace work to nowhere"
        );
        expect(Cause.pretty(result.cause)).toContain(
          "Set MISCHIEF_WORKSPACE_BRIDGE_URL"
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000
);
