import { Option, Schema } from "effect";

import { Count } from "../plans/schema.js";

export const ThinkReceiptSchema = Schema.Struct({
  effective: Schema.Struct({
    model: Schema.NullOr(Schema.String),
    thinking: Schema.NullOr(Schema.String),
  }),
  latencyMs: Schema.NullOr(Count),
  matched: Schema.Boolean,
  requested: Schema.Struct({
    from: Schema.Literals(["plan", "default"]),
    model: Schema.String,
    thinking: Schema.String,
  }),
  tokens: Schema.Struct({
    cacheRead: Count,
    input: Count,
    output: Count,
    total: Count,
  }),
});

export type ThinkReceipt = typeof ThinkReceiptSchema.Type;

export const ThinkTotalsSchema = Schema.Struct({
  calls: Count,
  mismatched: Count,
  models: Schema.Array(Schema.String),
  tokens: ThinkReceiptSchema.fields.tokens,
});

export type ThinkTotals = typeof ThinkTotalsSchema.Type;

const decodeReceipt = Schema.decodeUnknownOption(ThinkReceiptSchema);

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

const isList = Schema.is(Schema.Array(Schema.Json));

const receiptsIn = (value: Schema.Json): readonly ThinkReceipt[] => {
  if (isList(value)) {
    return value.flatMap(receiptsIn);
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, field]) =>
    key === "receipt"
      ? Option.match(decodeReceipt(field), {
          onNone: () => receiptsIn(field),
          onSome: (receipt) => [receipt],
        })
      : receiptsIn(field)
  );
};

const effectiveName = (receipt: ThinkReceipt) =>
  `${receipt.effective.model ?? receipt.requested.model}/${receipt.effective.thinking ?? receipt.requested.thinking}`;

export const thinkTotals = (
  entries: Iterable<Schema.Json>
): ThinkTotals | undefined => {
  const receipts = [...entries].flatMap(receiptsIn);

  if (receipts.length === 0) {
    return undefined;
  }

  const sum = (pick: (receipt: ThinkReceipt) => number) =>
    receipts.reduce((total, receipt) => total + pick(receipt), 0);

  return {
    calls: receipts.length,
    mismatched: receipts.filter(({ matched }) => !matched).length,
    models: [...new Set(receipts.map(effectiveName))].toSorted(),
    tokens: {
      cacheRead: sum(({ tokens }) => tokens.cacheRead),
      input: sum(({ tokens }) => tokens.input),
      output: sum(({ tokens }) => tokens.output),
      total: sum(({ tokens }) => tokens.total),
    },
  };
};

export const thinkLine = (totals: ThinkTotals) =>
  `think: ${totals.models.join(", ")} · ${totals.calls} call${totals.calls === 1 ? "" : "s"} · ${totals.tokens.total.toLocaleString("en-US")} tok (${totals.tokens.cacheRead.toLocaleString("en-US")} cached)${totals.mismatched > 0 ? ` · ${totals.mismatched} served by another model` : ""}`;
