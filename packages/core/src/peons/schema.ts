import { Schema } from "effect";

export const PeonId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/u)
);

export const PeonState = Schema.Literals([
  "spawned",
  "attaching",
  "running",
  "idle",
  "suspended",
  "hibernated",
  "destroyed",
]);

export const PeonThinking = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const Positive = Schema.Int.check(Schema.isGreaterThan(0));

export const PeonWorkspace = Schema.Struct({
  repo: Schema.String.check(
    Schema.isPattern(
      /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u
    )
  ),
  sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
});

const WarmDoc = Schema.Struct({
  path: Schema.String.check(
    Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[a-zA-Z0-9_./-]+$/u)
  ),
  text: Schema.String,
});

const Limits = Schema.Struct({
  cpus: Schema.Finite.check(Schema.isGreaterThan(0)),
  memory: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*[bkmg]$/u)),
  pids: Positive,
});

export const PeonTemplate = Schema.Struct({
  catalogModel: Schema.optionalKey(Schema.String),
  cellReady: Schema.optionalKey(Schema.Boolean),
  hibernateAfter: Positive,
  limits: Limits,
  model: Schema.String,
  needs: Schema.optionalKey(Schema.Array(Schema.String)),
  restriction: Schema.optionalKey(Schema.Literal("read-only")),
  suspendAfter: Positive,
  system: Schema.optionalKey(Schema.String),
  thinking: PeonThinking,
  tools: Schema.Literal("all"),
  warm: Schema.Struct({
    contract: Schema.optionalKey(Schema.String),
    docs: Schema.Array(WarmDoc),
  }),
  workspace: Schema.optional(PeonWorkspace),
});

export type PeonTemplateValue = typeof PeonTemplate.Type;

export const PeonOverrides = Schema.Struct({
  cellReady: Schema.optionalKey(Schema.Boolean),
  hibernateAfter: Schema.optionalKey(Positive),
  limits: Schema.optionalKey(
    Schema.Struct({
      cpus: Schema.optionalKey(Limits.fields.cpus),
      memory: Schema.optionalKey(Limits.fields.memory),
      pids: Schema.optionalKey(Positive),
    })
  ),
  model: Schema.optionalKey(Schema.String),
  needs: Schema.optionalKey(Schema.Array(Schema.String)),
  restriction: Schema.optionalKey(Schema.Literal("read-only")),
  suspendAfter: Schema.optionalKey(Positive),
  system: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(PeonThinking),
  tools: Schema.optionalKey(Schema.Literal("all")),
  warm: Schema.optionalKey(
    Schema.Struct({
      contract: Schema.optionalKey(Schema.String),
      docs: Schema.optionalKey(Schema.Array(WarmDoc)),
    })
  ),
  workspace: Schema.optionalKey(
    Schema.Struct({
      repo: Schema.optionalKey(PeonWorkspace.fields.repo),
      sha: Schema.optionalKey(PeonWorkspace.fields.sha),
    })
  ),
});

export const PeonTemplateRef = Schema.Struct({
  name: PeonId,
  version: Schema.optionalKey(Positive),
});

export const PeonTemplateSelector = Schema.Union([PeonId, PeonTemplateRef]);

export const peonTemplateReference = (
  selector: typeof PeonTemplateSelector.Type
): typeof PeonTemplateRef.Type =>
  Schema.is(PeonId)(selector) ? { name: selector } : selector;

export const PeonTemplateVersion = Schema.Struct({
  extends: Schema.optionalKey(PeonTemplateRef),
  name: PeonId,
  template: PeonTemplate,
  version: Positive,
});

export const PeonUsage = Schema.Struct({
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  input: Schema.Finite,
  output: Schema.Finite,
  total: Schema.Finite,
});

export const PeonTurn = Schema.Struct({
  exit: Schema.Finite,
  model: Schema.String,
  output: Schema.String,
  resumeMs: Schema.optionalKey(Schema.Finite),
  thinking: Schema.String,
  toolCalls: Schema.Array(Schema.String),
  usage: PeonUsage,
  wallMs: Schema.Finite,
});

export const PeonPromptLog = Schema.Struct({
  requestId: Schema.String,
  sender: Schema.optional(Schema.String),
  textHash: Schema.String,
  usage: PeonUsage,
  wallMs: Schema.Finite,
});

export const PeonIndexEntry = Schema.Struct({
  creationKey: Schema.optionalKey(Schema.String),
  destroyedAt: Schema.optionalKey(Schema.Finite),
  owner: Schema.String,
  peonId: PeonId,
  state: PeonState,
  template: PeonTemplateRef,
  updatedAt: Schema.Finite,
});

export const PeonTombstone = Schema.Struct({
  destroyedAt: Schema.Finite,
  owner: Schema.String,
  peonId: PeonId,
  state: Schema.Literal("destroyed"),
  template: PeonTemplateRef,
  updatedAt: Schema.Finite,
});

export const PeonReport = Schema.Struct({
  pending: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ kind: Schema.String, requestId: Schema.String })
    )
  ),
  ...PeonIndexEntry.fields,
  bytes: Schema.NullOr(
    Schema.Struct({
      home: Schema.Finite,
      snapshot: Schema.Finite,
      work: Schema.Finite,
    })
  ),
  fault: Schema.NullOr(Schema.String),
  lastTurn: Schema.NullOr(PeonTurn),
  resolvedTemplate: PeonTemplate,
  usage: PeonUsage,
});

export class PeonRefused extends Schema.TaggedError<PeonRefused>()(
  "PeonRefused",
  { reason: Schema.String }
) {
  override get message() {
    return this.reason;
  }
}

export const emptyPeonUsage = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
  total: 0,
};
