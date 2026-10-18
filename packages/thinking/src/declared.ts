import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ThinkingDeclaration } from "@mischief/core";

import type { PiThinkerOptions } from "./pi-thinker.js";

export const declaredThinkingOf = (
  models: PiThinkerOptions["models"],
  modelRefs: Readonly<Record<string, ModelRef>>,
  fallback: ThinkingDeclaration["fallback"]
): ThinkingDeclaration => ({
  fallback,
  models: Object.fromEntries(
    Object.entries(modelRefs).flatMap(([name, { modelId, provider }]) => {
      const model = models.getModel(provider, modelId);

      return model === undefined
        ? []
        : [[name, getSupportedThinkingLevels(model)] as const];
    })
  ),
});
