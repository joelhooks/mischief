import { PeonState } from "@mischief/core";
import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Schema } from "effect";

export class PromptFailed extends Schema.TaggedError<
  PromptFailed,
  { readonly brand: unique symbol }
>()("PromptFailed", {
  message: BridgeFailure.fields.message,
  state: Schema.optionalKey(PeonState),
  status: BridgeFailure.fields.status,
}) {}
