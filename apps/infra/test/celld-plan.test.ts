import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { offlineLayer } from "@rat-king/alchemy-nest/offline";
import { inMemoryState } from "alchemy/State";
import {
  ConfigProvider,
  Crypto,
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
import { mischiefMaintenanceScript, mischiefUnits } from "../units.ts";

const TAILNET = "100.64.0.7";

const DATA_ROOT = "/data/joel/mischief";

const PUBLIC_PORT = "28000";

const HOME = "/home/planner";

const Units = Schema.Struct({
  sections: Schema.Array(
    Schema.Struct({
      lines: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
      name: Schema.String,
    })
  ),
});

const sectionsIn = (text: string) =>
  text
    .trim()
    .split(/\n\s*\n/u)
    .map((block) => {
      const [header = "", ...lines] = block.split("\n");

      return {
        lines: lines.map((line) => {
          const at = line.indexOf("=");

          return [line.slice(0, at), line.slice(at + 1)];
        }),
        name: header.slice(1, -1),
      };
    });

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

const Purging = Schema.Struct({ purgeOnDelete: Schema.Boolean });

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
              MISCHIEF_BINDINGS_FILE:
                "/home/node/.config/mischief/bindings.json",
              MISCHIEF_CALLERS_FILE: callers,
              MISCHIEF_CELLD_NODE: "node",
              MISCHIEF_COMMIT: "0123456",
              MISCHIEF_DID: "did:web:mischief.example.invalid",
              MISCHIEF_MAILBOX_DID: "did:web:mailbox.example.invalid",
              MISCHIEF_MAILBOX_URL: "http://mailbox.example.invalid",
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
      expect(text).not.toMatch(/"d":/u);

      expect(text).not.toContain("Rat King");

      const sectionsOf = (fqn: string) =>
        Schema.decodeUnknownEffect(Units)(
          rows.find((row) => row.fqn === fqn)?.props
        ).pipe(
          Effect.map(({ sections }) =>
            Object.fromEntries(
              sections.map(({ lines, name }) => [
                name,
                Object.fromEntries(lines),
              ])
            )
          )
        );

      const slice = yield* sectionsOf("mischief-slice");

      expect(slice.Slice).toMatchObject({
        CPUQuota: "100%",
        MemoryHigh: "4.5G",
        MemoryMax: "5G",
      });

      expect(Object.keys(slice.Slice ?? {})).not.toContain("OOMPolicy");

      for (const [fqn, memoryMax] of [
        ["store/server", "2G"],
        ["celld/node", "3G"],
      ] as const) {
        const unit = yield* sectionsOf(fqn);

        expect([fqn, unit.Service]).toMatchObject([
          fqn,
          { CPUQuota: "100%", MemoryMax: memoryMax, OOMPolicy: "continue" },
        ]);

        expect(unit.Unit?.Description).toMatch(/^Mischief /u);
      }

      expect(
        rows.flatMap(({ fqn, props }) => {
          const declared = Schema.decodeUnknownOption(Purging)(props);

          return Option.isSome(declared)
            ? [[fqn, declared.value.purgeOnDelete]]
            : [];
        })
      ).toStrictEqual([
        ["store/data", false],
        ["store/bucket", false],
        ["celld/data", false],
      ]);

      const rendered = mischiefUnits({
        dataRoot: "/data/planner",
        home: HOME,
        ssh: "planner@node",
        tailnetIPv4: TAILNET,
      });

      expect(rendered.map(({ path: unit }) => path.basename(unit))).toEqual([
        "mischief.slice",
        "mischief-celld.service",
        "mischief-seaweedfs.service",
        "mischief-storage-retention.service",
        "mischief-storage-retention.timer",
      ]);

      for (const [fqn, file] of [
        ["mischief-slice", "mischief.slice"],
        ["celld/node", "mischief-celld.service"],
        ["store/server", "mischief-seaweedfs.service"],
      ] as const) {
        const fromPlan = yield* Schema.decodeUnknownEffect(Units)(
          rows.find((row) => row.fqn === fqn)?.props
        );

        const fromRender =
          rendered.find(({ path: unit }) => unit.endsWith(`/${file}`))?.text ??
          "";

        expect([fqn, sectionsIn(fromRender)]).toStrictEqual([
          fqn,
          fromPlan.sections.map(({ lines, name }) => ({
            lines: lines.map(([key, value]) => [key, value]),
            name,
          })),
        ]);
      }

      const script = mischiefMaintenanceScript({
        dataRoot: "/data/planner",
        home: HOME,
        ssh: "planner@node",
        tailnetIPv4: TAILNET,
      });

      const installed = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          content: Schema.Struct({
            length: Schema.Number,
            sha256: Schema.String,
          }),
        })
      )(rows.find(({ fqn }) => fqn === "store/storage-maintenance")?.props);

      const digest = yield* Crypto.Crypto.use((crypto) =>
        crypto.digest("SHA-256", new TextEncoder().encode(script.text))
      ).pipe(Effect.provide(NodeCrypto.layer));

      expect(installed.content).toStrictEqual({
        length: script.text.length,
        sha256: Buffer.from(digest).toString("hex"),
      });

      expect(script.text).not.toMatch(/\b1(?:8888|9333)\b/u);

      expect(
        rendered.find(({ path: unit }) =>
          unit.endsWith("/mischief-storage-retention.service")
        )?.text
      ).toMatch(
        /retain --instance "mischief" --master http:\/\/127\.0\.0\.1:28004 --filer http:\/\/127\.0\.0\.1:28002 /u
      );

      const configuration = rows.find(
        ({ fqn }) => fqn === "mischief-deployment-stage-configuration"
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
