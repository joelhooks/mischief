import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";

import { nodeSqliteStorageFor } from "./node-storage.js";
import type { PiThinkerOptions } from "./pi-thinker.js";

export const FAUX_MODEL_NAMES = [
  "fable",
  "haiku",
  "luna",
  "opus",
  "sol",
  "sonnet",
  "terra",
] as const;

const echo: FauxResponseFactory = (context) => {
  const last = context.messages.findLast((message) => message.role === "user");
  const content = last?.content ?? "";

  const prompt = Array.isArray(content)
    ? content.flatMap((block) => (block.type === "text" ? [block.text] : []))
    : [content];

  return fauxAssistantMessage(
    `faux answer to: ${prompt.join("").split("\n")[0] ?? ""}`
  );
};

export const fauxThinkerOptions = (root: string): PiThinkerOptions => {
  const faux = fauxProvider({ api: "faux" });
  const models = createModels();

  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 10_000 }, () => echo));

  const ref = { modelId: faux.getModel().id, provider: faux.provider.id };

  return {
    modelRefs: Object.fromEntries(FAUX_MODEL_NAMES.map((name) => [name, ref])),
    models,
    registry: createRegistry(),
    storageFor: nodeSqliteStorageFor(root),
  };
};
