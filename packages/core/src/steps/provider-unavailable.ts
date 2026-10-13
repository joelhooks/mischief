import { Data, Schema } from "effect";

export const ProviderCauseSchema = Schema.Literals([
  "billing",
  "busy",
  "server",
  "timeout",
]);

export type ProviderCause = typeof ProviderCauseSchema.Type;

export class ProviderUnavailable extends Data.TaggedError(
  "ProviderUnavailable"
)<{
  readonly cause: ProviderCause;
  readonly key: string;
  readonly provider: string;
  readonly status: number | null;
}> {}
