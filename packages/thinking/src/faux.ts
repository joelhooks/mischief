// @effect-diagnostics asyncFunction:off -- faux response factories are async, and one that hangs awaits a Promise that never settles.
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { Effect } from "effect";

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

export type FauxReply =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "hang" };

const echo = (prompt: string): FauxReply => ({
  kind: "answer",
  text: `faux answer to: ${prompt.split("\n")[0] ?? ""}`,
});

const replyWith =
  (respond: (prompt: string) => FauxReply): FauxResponseFactory =>
  async (context) => {
    const last = context.messages.findLast(
      (message) => message.role === "user"
    );

    const content = last?.content ?? "";

    const prompt = Array.isArray(content)
      ? content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("")
      : content;

    const reply = respond(prompt);

    if (reply.kind === "hang") {
      return await Effect.runPromise(Effect.never);
    }

    return reply.kind === "error"
      ? fauxAssistantMessage("", {
          errorMessage: reply.message,
          stopReason: "error",
        })
      : fauxAssistantMessage(reply.text);
  };

export const fauxThinkerOptions = (
  storageFor: PiThinkerOptions["storageFor"],
  respond: (prompt: string) => FauxReply = echo
): PiThinkerOptions => {
  const faux = fauxProvider({ api: "faux" });
  const models = createModels();

  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 10_000 }, () => replyWith(respond)));

  const ref = { modelId: faux.getModel().id, provider: faux.provider.id };

  return {
    modelRefs: Object.fromEntries(FAUX_MODEL_NAMES.map((name) => [name, ref])),
    models,
    registry: createRegistry(),
    storageFor,
  };
};
