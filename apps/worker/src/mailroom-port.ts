import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { PostboxFailed } from "./postbox-failed.js";

export interface Sealed {
  readonly envelope: string;
  readonly messageId: string;
}

export interface Inbound {
  readonly body: string;
  readonly messageId: string;
  readonly replyTo: Option.Option<string>;
  readonly senderDid: string;
}

export const SendVerdict = Schema.TaggedUnion({
  Accepted: {},
  Conflict: {},
  Refused: { reason: Schema.String },
  Uncertain: { reason: Schema.String },
});

export type SendVerdictValue = typeof SendVerdict.Type;

export class Mailroom extends Context.Service<
  Mailroom,
  {
    readonly nameOf: (did: string) => Effect.Effect<Option.Option<string>>;
    readonly seal: (
      to: string,
      body: string
    ) => Effect.Effect<Sealed, PostboxFailed>;
    readonly send: (envelope: string) => Effect.Effect<SendVerdictValue>;
    readonly surface: (summary: string, body: string) => Effect.Effect<void>;
    readonly tell: (
      to: string,
      summary: string,
      body: string
    ) => Effect.Effect<void>;
  }
>()("@mischief/worker/Mailroom") {}
