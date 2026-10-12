import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { PostboxFailed } from "./postbox-failed.js";

export const Delivered = Schema.TaggedUnion({
  Journaled: {},
  Refused: { reason: Schema.String },
});

export type DeliveredValue = typeof Delivered.Type;

export interface ReplyLine {
  readonly body: string;
  readonly from: string;
  readonly messageId: string;
  readonly replyTo: string;
}

export class Runs extends Context.Service<
  Runs,
  {
    readonly deliver: (
      objectName: string,
      line: ReplyLine
    ) => Effect.Effect<DeliveredValue, PostboxFailed>;
  }
>()("@mischief/worker/Runs") {}
