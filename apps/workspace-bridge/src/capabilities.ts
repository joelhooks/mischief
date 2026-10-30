import { defineContract } from "@mischief/capability/contract";
import { implement } from "@mischief/capability/implement";
import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { CompletionSchema } from "@mischief/model-bridge/protocol";

import { Bridge } from "./bridge.js";
import { WorkspaceRequestSchema } from "./protocol.js";

export const completeWorkspace = implement(
  defineContract("completeWorkspace", {
    annotations: { idempotent: false, readOnly: true },
    description:
      "Complete a read-only review of one allowlisted repository at a pinned commit",
    failure: BridgeFailure,
    input: WorkspaceRequestSchema,
    output: CompletionSchema,
  }),
  (input) => Bridge.use(({ run }) => run(input))
);
