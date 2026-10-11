import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { offlineLayer } from "@rat-king/alchemy-nest/offline";
import { inMemoryState } from "alchemy/State";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";

import { celldStack } from "../celld.ts";
import { reviewRows } from "../plan-review.ts";
import { planWith } from "../plan-runtime.ts";

const TAILNET = "100.64.0.7";

const DATA_ROOT = "/data/joel/mischief";

const PUBLIC_PORT = "28000";

const HOME = "/home/planner";

const CALLERS = [
  {
    authentication: ["did:web:driver.example.invalid#atproto"],
    id: "did:web:driver.example.invalid",
    keyAgreement: [],
    verificationMethod: [
      {
        controller: "did:web:driver.example.invalid",
        id: "did:web:driver.example.invalid#atproto",
        publicKeyJwk: {
          crv: "P-256",
          kty: "EC",
          x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
          y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
        },
      },
    ],
  },
];

const inventoryOf = (dataRoot: string) => ({
  domains: ["example.test"],
  hosts: ["node"],
  ips: [TAILNET],
  nodes: {
    node: { dataRoot, home: HOME, ssh: "planner@node", tailnetIPv4: TAILNET },
  },
  secretNames: ["NONE"],
  sites: ["example"],
});

it.effect(
  "the celld plan only creates, carries the mischief instance everywhere, and keeps every port but the public one on loopback",
  () =>
    Effect.gen(function* planned() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const inventory = path.join(dir, "instance.json");

      const callers = path.join(dir, "callers.json");

      yield* fs.writeFileString(callers, JSON.stringify(CALLERS));

      yield* fs.writeFileString(
        inventory,
        JSON.stringify(inventoryOf("/data/planner")),
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
              MISCHIEF_CALLERS_FILE: callers,
              MISCHIEF_CELLD_NODE: "node",
              MISCHIEF_COMMIT: "0123456",
              MISCHIEF_DID: "did:web:mischief.example.invalid",
              MISCHIEF_VERSION: "0.1.0",
              RATS_NEST_INSTANCE: inventory,
            })
          )
        )
      );

      expect(Option.isSome(plan)).toBe(true);

      const rows = Option.isSome(plan)
        ? yield* reviewRows(plan.value).pipe(Effect.provide(NodeCrypto.layer))
        : [];

      const text = JSON.stringify(rows);

      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map(({ action }) => action))).toEqual(
        new Set(["create"])
      );
      expect(text).not.toContain("rat-king");
      expect(text).not.toMatch(/\b18\d{3}\b/u);

      expect(
        [...new Set(text.match(/[\w.-]+\.(?:service|slice|timer)\b/gu))].every(
          (unit) => unit.startsWith("mischief")
        )
      ).toBe(true);

      const ports = [...text.matchAll(/(?<host>[\d.]+):(?<port>2800\d)\b/gu)];

      expect(ports.length).toBeGreaterThan(0);

      for (const { groups } of ports) {
        expect(groups?.host).toBe(
          groups?.port === PUBLIC_PORT ? TAILNET : "127.0.0.1"
        );
      }

      expect(text).not.toContain("CREDENTIAL");

      const configuration = rows.find(
        ({ fqn }) => fqn === "deployment-configuration"
      );

      const { content } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ content: Schema.String })
      )(configuration?.props);

      const { vars } = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ vars: Schema.Record(Schema.String, Schema.String) })
        )
      )(content);

      expect(vars).toMatchObject({
        MISCHIEF_CALLERS: JSON.stringify(CALLERS),
        MISCHIEF_DID: "did:web:mischief.example.invalid",
      });

      const paths = [...text.matchAll(/\/(?:home|data)\/[\w./-]+/gu)].map(
        ([found]) => found
      );

      expect(
        paths.every(
          (found) =>
            found.startsWith(DATA_ROOT) ||
            found === HOME ||
            found.startsWith(`${HOME}/.config/mischief`) ||
            found.startsWith(`${HOME}/.local/share/mischief`)
        )
      ).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))
    ),
  120_000
);
