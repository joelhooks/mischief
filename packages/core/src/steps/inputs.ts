import { Schema } from "effect";

import {
  AgentConfigSchema,
  DocKey,
  EphemeralSourceSchema,
  PostSchema,
  Probability,
  RatKingName,
} from "../plans/schema.js";

export const ThinkInputSchema = Schema.Struct({
  agent: Schema.optionalKey(AgentConfigSchema),
  ephemeral: Schema.optionalKey(EphemeralSourceSchema),
  key: Schema.String,
  post: Schema.optionalKey(PostSchema),
  prompt: Schema.String,
  writes: Schema.optionalKey(DocKey),
});

export type ThinkInput = typeof ThinkInputSchema.Type;

export const AskInputSchema = Schema.Struct({
  key: Schema.String,
  message: Schema.String,
  to: RatKingName,
  writes: Schema.optionalKey(DocKey),
});

export type AskInput = typeof AskInputSchema.Type;

export const QuestionInputSchema = Schema.Struct({
  criteria: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  key: Schema.String,
  options: Schema.Array(Schema.String),
  question: Schema.String,
  reason: Schema.optionalKey(Schema.String),
});

export type QuestionInput = typeof QuestionInputSchema.Type;

export const JudgeInputSchema = Schema.Struct({
  ...QuestionInputSchema.fields,
  fallback: Schema.optional(Schema.String),
  reads: Schema.optional(Schema.Array(DocKey)),
  thinkAgent: Schema.optional(AgentConfigSchema),
  thinkThreshold: Schema.optional(Probability),
  threshold: Schema.optional(Probability),
});

export type JudgeInput = typeof JudgeInputSchema.Type;

export const SwitchInputSchema = Schema.Struct({
  cases: Schema.Record(Schema.String, Schema.String),
  default: Schema.String,
  key: Schema.String,
  reads: DocKey,
});

export type SwitchInput = typeof SwitchInputSchema.Type;

export const CallInputSchema = Schema.Struct({
  capability: Schema.String,
  input: Schema.optionalKey(Schema.Json),
  key: Schema.String,
  reads: Schema.optionalKey(Schema.Array(DocKey)),
  writes: Schema.optionalKey(DocKey),
});

export type CallInput = typeof CallInputSchema.Type;

export const ElaborateInputSchema = Schema.Struct({
  goal: Schema.String,
  key: Schema.String,
});

export type ElaborateInput = typeof ElaborateInputSchema.Type;

export const PickParamsSchema = Schema.Struct({ option: Schema.String });

export const JudgeVerdictSchema = Schema.Struct({
  choice: Schema.optionalKey(Schema.String),
  escalate: Schema.optionalKey(Schema.Boolean),
});

export type JudgeVerdict = typeof JudgeVerdictSchema.Type;

export const OutputEventSchema = Schema.Struct({
  output: JudgeVerdictSchema,
});
