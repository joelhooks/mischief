import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Schema } from "effect";

export class PromptFailed extends Schema.TaggedError<
  PromptFailed,
  { readonly brand: unique symbol }
>()("PromptFailed", {
  message: BridgeFailure.fields.message,
  status: BridgeFailure.fields.status,
}) {}
