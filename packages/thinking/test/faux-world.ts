// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- The faux world logs model calls to a file shared with a crashing child process, and faux response factories are async.
import { appendFileSync, readFileSync } from "node:fs";

import type { UserMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { Effect, Schema } from "effect";
import { constUndefined, constVoid } from "effect/Function";

import type { PiThinkerOptions } from "../dist/index.js";
import { nodeSqliteStorageFor } from "../dist/node-storage.js";

const PICK = /^pick:(?<choice>[^:]*):(?<confidence>[0-9.]+)/u;

const isText = Schema.is(Schema.String);

const textOf = (content: UserMessage["content"] | undefined) => {
  if (content === undefined) {
    return "";
  }

  return isText(content)
    ? content
    : content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
};

export const callsOf = (dir: string) => {
  try {
    return readFileSync(`${dir}/calls.log`, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
};

export const fauxWorld = (
  dir: string,
  hang: boolean,
  onCall: () => void = constVoid,
  providerError: () => string | undefined = constUndefined
): PiThinkerOptions => {
  const faux = fauxProvider({ api: "faux" });
  const models = createModels();

  models.setProvider(faux.provider);

  const answer: FauxResponseFactory = async (context) => {
    const users = context.messages.flatMap((message) =>
      message.role === "user" ? [message] : []
    );

    const prompt = textOf(users.at(-1)?.content);

    appendFileSync(`${dir}/calls.log`, `${prompt.split("\n")[0]}\n`);
    onCall();

    if (hang) {
      return await Effect.runPromise(Effect.never);
    }

    const errorMessage = providerError();

    if (errorMessage !== undefined) {
      return fauxAssistantMessage("", { errorMessage, stopReason: "error" });
    }

    const { choice, confidence } = PICK.exec(prompt)?.groups ?? {};

    return fauxAssistantMessage(
      choice === undefined
        ? `answer:${prompt}:${users.length}`
        : JSON.stringify({ choice, confidence: Number(confidence) })
    );
  };

  faux.setResponses(Array.from({ length: 200 }, () => answer));

  return {
    modelRefs: {
      sol: { modelId: faux.getModel().id, provider: faux.provider.id },
    },
    models,
    registry: createRegistry(),
    storageFor: nodeSqliteStorageFor(dir),
  };
};
