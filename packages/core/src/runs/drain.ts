import { Effect, Option, Schema } from "effect";

import { RunHost } from "./host.js";
import { ReplyLineSchema } from "./schema.js";

export const DrainOutcomeSchema = Schema.TaggedUnion({
  Delivered: { replyTo: Schema.String, status: Schema.String },
  Refused: { reason: Schema.String, replyTo: Schema.String },
  Unrouted: { line: Schema.String, reason: Schema.String },
});

export type DrainOutcome = typeof DrainOutcomeSchema.Type;

export const UNROUTED_REASON =
  "not a reply to a Mischief ask: it needs string body and replyTo fields. Kept in __unrouted.jsonl; read it there and answer the sender directly";

const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(ReplyLineSchema)
);

export const consumeDrained = Effect.fn("consumeDrained")(function* consume(
  raw: string
) {
  const line = decodeLine(raw);

  if (Option.isNone(line)) {
    return DrainOutcomeSchema.cases.Unrouted.make({
      line: raw,
      reason: UNROUTED_REASON,
    });
  }

  const { replyTo } = line.value;

  return yield* RunHost.use((host) => host.deliver(line.value)).pipe(
    Effect.map(({ status }) =>
      DrainOutcomeSchema.cases.Delivered.make({ replyTo, status })
    ),
    Effect.catchTag("ReplyRefused", ({ reason }) =>
      Effect.succeed(DrainOutcomeSchema.cases.Refused.make({ reason, replyTo }))
    )
  );
});
