// @effect-diagnostics asyncFunction:off -- pi-ai resolves provider auth through an async callback.
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { Redacted } from "effect";

import type { PiThinkerOptions } from "./pi-thinker.js";

export const GATEWAY_MODELS = {
  luna: "gpt-6-luna",
  sol: "gpt-6-sol",
  terra: "gpt-5.6-terra",
} as const;

const PROVIDER = "mischief-gateway";

export interface GatewayConfig {
  readonly apiKey: Redacted.Redacted;
  readonly baseUrl: string;
}

export const gatewayThinkerOptions = (
  storageFor: PiThinkerOptions["storageFor"],
  { apiKey, baseUrl }: GatewayConfig
): PiThinkerOptions => {
  const models = createModels();

  models.setProvider(
    createProvider({
      api: openAIResponsesApi(),
      auth: {
        apiKey: {
          name: "Mischief model gateway key",
          resolve: async () =>
            await Promise.resolve({
              auth: {
                apiKey: Redacted.value(apiKey),
                headers: {
                  Authorization: `Bearer ${Redacted.value(apiKey)}`,
                },
              },
            }),
        },
      },
      baseUrl,
      id: PROVIDER,
      models: Object.values(GATEWAY_MODELS).map((id) => ({
        api: "openai-responses" as const,
        baseUrl,
        contextWindow: 272_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id,
        input: Array.of<"text">("text"),
        maxTokens: 32_000,
        name: id,
        provider: PROVIDER,
        reasoning: true,
      })),
    })
  );

  return {
    modelRefs: Object.fromEntries(
      Object.entries(GATEWAY_MODELS).map(([name, modelId]) => [
        name,
        { modelId, provider: PROVIDER },
      ])
    ),
    models,
    registry: createRegistry(),
    storageFor,
  };
};
