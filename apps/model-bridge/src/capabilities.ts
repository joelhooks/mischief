import { defineContract } from "@mischief/capability/contract";
import { implement } from "@mischief/capability/implement";

import { BridgeFailure } from "./bridge-failure.js";
import { Bridge } from "./bridge.js";
import { CompletionSchema, ResponsesRequestSchema } from "./protocol.js";

const completeReviewContract = defineContract("completeReview", {
  annotations: { idempotent: false, readOnly: true },
  description:
    "Complete one text-only Opus review through the honest Claude client",
  failure: BridgeFailure,
  input: ResponsesRequestSchema,
  output: CompletionSchema,
});

export const completeReview = implement(completeReviewContract, (input) =>
  Bridge.use(({ run }) => run(input))
);

export const capabilities = [completeReview] as const;
