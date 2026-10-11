import { Context, Effect, Layer, Schema } from "effect";

import { StepFailed } from "./step-failed.js";
import type { StepCall } from "./step-failed.js";

export const SealedSchema = Schema.Struct({
  envelope: Schema.String,
  messageId: Schema.String,
});

export type Sealed = typeof SealedSchema.Type;

const unwired = (call: StepCall) =>
  Effect.fail(
    new StepFailed({
      key: call.key,
      reason: "Mail is not wired on this host",
    })
  );

export class Mail extends Context.Service<
  Mail,
  {
    readonly seal: (
      call: StepCall & { readonly message: string; readonly to: string }
    ) => Effect.Effect<Sealed, StepFailed>;
    readonly send: (
      call: StepCall,
      sealed: Sealed
    ) => Effect.Effect<void, StepFailed>;
  }
>()("@mischief/core/Mail") {
  static readonly unwired = Layer.succeed(this, {
    seal: unwired,
    send: unwired,
  });
}
