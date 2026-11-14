import { Effect, Schema } from "effect";

export const PeonId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/u)
);

export const RequestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512)
);

export const Template = Schema.Struct({
  limits: Schema.Struct({
    cpus: Schema.Finite.check(Schema.isGreaterThan(0)),
    memory: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*[bkmg]$/u)),
    pids: Schema.Int.check(Schema.isGreaterThan(0)),
    tmp: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*[bkmg]$/u)).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("1g"))
    ),
  }),
  model: Schema.Literals(["opus", "sol"]),
  system: Schema.optionalKey(Schema.String),
  thinking: Schema.Literals([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]),
  tools: Schema.Literal("all"),
  warm: Schema.optionalKey(
    Schema.Struct({
      contract: Schema.optionalKey(Schema.String),
      docs: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            path: Schema.String.check(
              Schema.isPattern(
                /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[a-zA-Z0-9_./-]+$/u
              )
            ),
            text: Schema.String,
          })
        )
      ),
    })
  ),
  workspace: Schema.Struct({
    repo: Schema.String.check(
      Schema.isPattern(
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u
      )
    ),
    sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  }),
});

export const State = Schema.Literals([
  "absent",
  "idle",
  "running",
  "suspended",
  "hibernated",
  "destroyed",
]);

export const Snapshot = Schema.Struct({
  bytes: Schema.Finite,
  path: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});

export const Metadata = Schema.Struct({
  image: Schema.String,
  lastPromptAt: Schema.NullOr(Schema.Finite),
  peonId: PeonId,
  snapshot: Schema.optionalKey(Snapshot),
  state: State,
  template: Template,
});

export const Usage = Schema.Struct({
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  input: Schema.Finite,
  output: Schema.Finite,
  total: Schema.Finite,
});

export const PromptResult = Schema.Struct({
  exit: Schema.Finite,
  model: Schema.String,
  output: Schema.String,
  resumeMs: Schema.Finite,
  thinking: Template.fields.thinking,
  toolCalls: Schema.Array(Schema.String),
  usage: Usage,
  wallMs: Schema.Finite,
});

export const Create = Schema.Struct({
  peonId: PeonId,
  requestId: RequestId,
  template: Template,
});

export const Action = Schema.Struct({
  action: Schema.Literals([
    "prompt",
    "suspend",
    "resume",
    "hibernate",
    "clone",
    "destroy",
  ]),
  newPeonId: Schema.optionalKey(PeonId),
  peonId: PeonId,
  requestId: RequestId,
  text: Schema.optionalKey(Schema.String),
});

export const Result = Schema.Record(Schema.String, Schema.Unknown);

export type BoxMetadata = typeof Metadata.Type;

export type BoxTemplate = typeof Template.Type;
