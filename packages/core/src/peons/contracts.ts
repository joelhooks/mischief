import { defineContract } from "@mischief/capability/contract";
import { Schema } from "effect";

import {
  PeonId,
  PeonIndexEntry,
  PeonOverrides,
  PeonRefused,
  PeonReport,
  PeonState,
  PeonTemplateSelector,
  PeonTemplateVersion,
  PeonTombstone,
} from "./schema.js";

const requestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512)
);

export const spawnPeonContract = defineContract("spawnPeon", {
  annotations: { openWorld: true },
  description:
    "Spawn a full-tool peon from a versioned template. Supply a pinned workspace in overrides. Idempotent when peonId is supplied.",
  failure: PeonRefused,
  input: Schema.Struct({
    overrides: Schema.optionalKey(PeonOverrides),
    peonId: Schema.optionalKey(PeonId),
    template: PeonTemplateSelector,
  }),
  output: PeonReport,
});

export const promptPeonContract = defineContract("promptPeon", {
  annotations: { idempotent: true, openWorld: true },
  description:
    "Wake a peon and run one turn. Repeating requestId returns the original turn; changing its text is refused to prevent duplicate work.",
  failure: PeonRefused,
  input: Schema.Struct({ peonId: PeonId, requestId, text: Schema.String }),
  output: PeonReport,
});

const lifecycle = {
  failure: PeonRefused,
  input: Schema.Struct({
    peonId: PeonId,
    requestId: Schema.optionalKey(requestId),
  }),
  output: PeonReport,
};

export const suspendPeonContract = defineContract("suspendPeon", {
  ...lifecycle,
  annotations: { idempotent: true },
  description:
    "Stop the box and keep its workspace. One alarm remains for hibernation.",
});

export const resumePeonContract = defineContract("resumePeon", {
  ...lifecycle,
  annotations: { idempotent: true },
  description: "Wake a suspended or hibernated box without starting a turn.",
});

export const hibernatePeonContract = defineContract("hibernatePeon", {
  ...lifecycle,
  annotations: { idempotent: true },
  description: "Snapshot a stopped peon and release its box storage.",
});

export const destroyPeonContract = defineContract("destroyPeon", {
  ...lifecycle,
  annotations: { destructive: true, idempotent: true },
  description:
    "Remove a peon box, keeping its last snapshot and registry tombstone.",
  output: Schema.Union([PeonReport, PeonTombstone]),
});

export const clonePeonContract = defineContract("clonePeon", {
  annotations: { openWorld: true },
  description:
    "Clone an idle or sleeping peon's workspace and conversation into a suspended peon.",
  failure: PeonRefused,
  input: Schema.Struct({
    newPeonId: Schema.optionalKey(PeonId),
    peonId: PeonId,
    requestId: Schema.optionalKey(requestId),
  }),
  output: PeonReport,
});

export const inspectPeonContract = defineContract("inspectPeon", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "Inspect the durable peon state, template, usage, last turn and box storage bytes.",
  failure: PeonRefused,
  input: Schema.Struct({ peonId: PeonId }),
  output: Schema.Union([PeonReport, PeonTombstone]),
});

export const listPeonTemplatesContract = defineContract("listPeonTemplates", {
  annotations: { idempotent: true, readOnly: true },
  description: "List the latest version of each template, paged by name.",
  failure: PeonRefused,
  input: Schema.Struct({
    cursor: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }))
    ),
  }),
  output: Schema.Struct({
    cursor: Schema.NullOr(Schema.String),
    templates: Schema.Array(PeonTemplateVersion),
  }),
});

export const savePeonTemplateContract = defineContract("savePeonTemplate", {
  description:
    "Resolve a parent version and deep merge overrides into a new immutable template version.",
  failure: PeonRefused,
  input: Schema.Struct({
    extends: PeonTemplateSelector,
    name: PeonId,
    overrides: PeonOverrides,
  }),
  output: PeonTemplateVersion,
});

export const listPeonsContract = defineContract("listPeons", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "List the caller's awake peons from the registry, never the Rat King directory. Select sleeping peons or tombstones with state, an array of states, or all. Owner, template and state filters apply before pagination.",
  failure: PeonRefused,
  input: Schema.Struct({
    cursor: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }))
    ),
    owner: Schema.optionalKey(Schema.String),
    state: Schema.optionalKey(
      Schema.Union([PeonState, Schema.Array(PeonState), Schema.Literal("all")])
    ),
    template: Schema.optionalKey(Schema.String),
  }),
  output: Schema.Struct({
    cursor: Schema.NullOr(Schema.String),
    peons: Schema.Array(PeonIndexEntry),
  }),
});

export const peonContracts = [
  spawnPeonContract,
  promptPeonContract,
  suspendPeonContract,
  resumePeonContract,
  hibernatePeonContract,
  clonePeonContract,
  destroyPeonContract,
  inspectPeonContract,
  listPeonTemplatesContract,
  savePeonTemplateContract,
  listPeonsContract,
] as const;

export const peonCapabilityNames: ReadonlySet<string> = new Set(
  peonContracts.map(({ name }) => name)
);
