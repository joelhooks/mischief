import { PeonRefused, PeonId, PeonReport, PeonWorkspace } from "@mischief/core";
import { Schema } from "effect";

export const PEON_REGISTRY = "peons-v1";

export const PeonPending = Schema.Struct({
  boxRequestId: Schema.String,
  inputHash: Schema.String,
  discardWorkspace: Schema.optional(Schema.Literal(true)),
  landedHead: Schema.optional(Schema.String),
  kind: Schema.Literals([
    "spawn",
    "prompt",
    "suspend",
    "resume",
    "hibernate",
    "clone",
    "destroy",
  ]),
  mail: Schema.optionalKey(Schema.Boolean),
  newPeonId: Schema.optional(PeonId),
  requestId: Schema.String,
  failures: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  ),
  retryAt: Schema.optionalKey(Schema.Finite),
  resumeRequestId: Schema.String,
  sender: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  textHash: Schema.optional(Schema.String),
});

export const PeonStored = Schema.Struct({
  idleAt: Schema.Finite,
  lastTurnId: Schema.optionalKey(Schema.String),
  pending: Schema.NullOr(PeonPending),
  report: PeonReport,
});

export type PeonStoredValue = typeof PeonStored.Type;

export const PeonCompleted = Schema.Struct({
  hash: Schema.String,
  refusal: Schema.optionalKey(
    Schema.Struct({
      code: PeonRefused.fields.code,
      httpStatus: PeonRefused.fields.httpStatus,
      managerCode: PeonRefused.fields.managerCode,
      reason: PeonRefused.fields.reason,
    })
  ),
  report: PeonReport,
});

export const PeonBoxState = Schema.Struct({
  processes: PeonReport.fields.processes,
  bytes: PeonReport.fields.bytes,
  container: Schema.NullOr(Schema.String),
  lastPromptAt: Schema.NullOr(Schema.Union([Schema.String, Schema.Finite])),
  state: Schema.String,
});

export const PeonBoxCreated = Schema.Struct({
  image: Schema.String,
  peonId: PeonId,
  state: Schema.Literal("idle"),
  workspace: PeonWorkspace,
});

export const PeonBoxCloned = Schema.Struct({
  peonId: PeonId,
  state: Schema.Literal("suspended"),
});

export { PeonTurn as PeonBoxTurn } from "@mischief/core";
