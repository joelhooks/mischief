import { Effect, Schema } from "effect";

import catalog from "./catalog.v1.json" with { type: "json" };
import type { PeonOverrides, PeonTemplateVersion } from "./schema.js";
import { PeonRefused, PeonTemplate, PeonThinking } from "./schema.js";

export const PEON_CATALOG_SOURCE = {
  commit: "2f8c2751d0327650998879dabce3d9f2b99b9111",
  deferredDocs: "Per-template warmup.md files are deferred until slice 1b",
  repo: "joelhooks/peons",
  sha256: "8891e9fe41985ab588b7007c308f1572cab3067dea4626331b2734b235571f0a",
};

export const PeonCatalog = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      cellReady: Schema.Boolean,
      evidence: Schema.Struct({
        count: Schema.Finite,
        repoCount: Schema.Finite,
        source: Schema.String,
      }),
      input: Schema.String,
      kind: Schema.String,
      model: Schema.String,
      needs: Schema.Array(Schema.String),
      output: Schema.String,
      owner: Schema.String,
      refusals: Schema.Array(Schema.String),
      summary: Schema.String,
      template: Schema.String,
      thinking: PeonThinking,
      verify: Schema.String,
      version: Schema.Finite,
    })
  ),
  schema: Schema.Literal("peons.catalog.v1"),
});

export const peonCatalog = Schema.decodeUnknownSync(PeonCatalog)(catalog);

export const fullPeonTemplate: typeof PeonTemplate.Type = {
  hibernateAfter: 86_400_000,
  limits: { cpus: 2, memory: "4g", pids: 512 },
  model: "opus",
  suspendAfter: 60_000,
  thinking: "medium",
  tools: "all",
  warm: { docs: [] },
};

export const mergePeonTemplate = (
  base: typeof PeonTemplate.Type,
  overrides: typeof PeonOverrides.Type
) =>
  Schema.decodeUnknownEffect(PeonTemplate)({
    ...base,
    ...overrides,
    limits: { ...base.limits, ...overrides.limits },
    warm: { ...base.warm, ...overrides.warm },
    workspace:
      base.workspace === undefined && overrides.workspace === undefined
        ? undefined
        : { ...base.workspace, ...overrides.workspace },
  }).pipe(
    Effect.mapError(
      () =>
        new PeonRefused({
          reason:
            "Template overrides do not resolve to a valid template. Supply a complete owner/repo and 40-hex SHA workspace, positive limits and millisecond timers; retry savePeonTemplate or spawnPeon.",
        })
    ),
    Effect.filterOrFail(
      (template) => template.model === "opus" || template.model === "sol",
      (template) =>
        new PeonRefused({
          reason: `Model ${template.model} is outside the slice-1 box map; substituting it would run the wrong model. Set model to opus or sol in savePeonTemplate or spawnPeon overrides. Wider models are a later slice.`,
        })
    )
  );

export const builtinPeonTemplates: readonly (typeof PeonTemplateVersion.Type)[] =
  [
    { name: "full", template: fullPeonTemplate, version: 1 },
    {
      extends: { name: "full", version: 1 },
      name: "read-only",
      template: { ...fullPeonTemplate, restriction: "read-only" },
      version: 1,
    },
    ...peonCatalog.entries.map((entry) => ({
      extends: { name: "full", version: 1 },
      name: entry.template,
      template: {
        ...fullPeonTemplate,
        catalogModel: entry.model,
        cellReady: entry.cellReady,
        model: entry.model === "opus" ? "opus" : "sol",
        needs: entry.needs,
        thinking: entry.thinking,
        warm: {
          contract: [
            entry.summary,
            `Input: ${entry.input}`,
            `Output: ${entry.output}`,
            `Evidence: ${JSON.stringify(entry.evidence)}`,
            `Verify: ${entry.verify}`,
            ...entry.refusals,
          ].join("\n\n"),
          docs: [],
        },
      },
      version: 1,
    })),
  ];
