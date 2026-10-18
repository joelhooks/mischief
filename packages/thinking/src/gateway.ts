// @effect-diagnostics asyncFunction:off -- pi-ai resolves provider auth and rewrites payloads through async callbacks.
import type {
  ProviderStreams,
  StreamOptions,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { Hash, Redacted, Schema } from "effect";

import { declaredThinkingOf } from "./declared.js";
import type { PiThinkerOptions } from "./pi-thinker.js";
import type { ThinkDefaults } from "./receipt.js";

export const GATEWAY_MODELS = {
  "gpt-6-luna": "gpt-6-luna",
  "gpt-6.1-sol": "gpt-6.1-sol",
  luna: "gpt-6-luna",
  sol: "gpt-6.1-sol",
} as const;

type GatewayModelId = (typeof GATEWAY_MODELS)[keyof typeof GATEWAY_MODELS];

interface ModelLimits {
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly thinkingLevelMap?: ThinkingLevelMap;
}

const LIMITS: Readonly<Record<GatewayModelId, ModelLimits>> = {
  "gpt-6-luna": {
    contextWindow: 272_000,
    maxTokens: 128_000,
    thinkingLevelMap: { max: "max", xhigh: "xhigh" },
  },
  "gpt-6.1-sol": { contextWindow: 272_000, maxTokens: 32_000 },
};

export const THINK_DEFAULT: ThinkDefaults = {
  model: "gpt-6.1-sol",
  thinking: "medium",
};

export const THINK_DEFAULT_REVIEW = "2026-11-15";

const PROVIDER = "cliproxy-codex";

const PROMPT_CACHE_KEY_MAX = 64;

const RUN_CACHE_KEY = "mischiefPromptCacheKey";

export const promptCacheKeyOf = (runId: string) => {
  const key = `mischief-${runId}`;

  return key.length <= PROMPT_CACHE_KEY_MAX
    ? key
    : `mischief-${runId.slice(0, 40)}-${Math.abs(Hash.string(runId)).toString(36)}`;
};

const isPayload = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const isKey = Schema.is(Schema.String);

const keyed = (options: StreamOptions): StreamOptions => {
  const key = options.metadata?.[RUN_CACHE_KEY];

  if (!isKey(key) || options.cacheRetention === "none") {
    return options;
  }

  const { onPayload } = options;

  return {
    ...options,
    onPayload: async (payload, model) => {
      const prior = (await onPayload?.(payload, model)) ?? payload;

      return isPayload(prior) ? { ...prior, prompt_cache_key: key } : prior;
    },
    sessionId: key,
  };
};

const gatewayStreams = (
  api: ProviderStreams,
  fetch: StreamOptions["fetch"]
): ProviderStreams => {
  const optionsOf = (options: StreamOptions | undefined) => {
    const next: StreamOptions = { ...options };

    if (fetch !== undefined) {
      next.fetch = fetch;
    }

    return keyed(next);
  };

  return {
    ...api,
    stream: (model, context, options) =>
      api.stream(model, context, optionsOf(options)),
    streamSimple: (model, context, options) =>
      api.streamSimple(model, context, optionsOf(options)),
  };
};

export interface GatewayConfig {
  readonly apiKey: Redacted.Redacted;
  readonly baseUrl: string;
  readonly fetch?: StreamOptions["fetch"];
}

export const gatewayThinkerOptions = (
  storageFor: PiThinkerOptions["storageFor"],
  { apiKey, baseUrl, fetch }: GatewayConfig
): PiThinkerOptions => {
  const models = createModels();

  models.setProvider(
    createProvider({
      api: gatewayStreams(openAIResponsesApi(), fetch),
      auth: {
        apiKey: {
          name: "Mischief cliproxy key (mischief-celld)",
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
      models: [...new Set(Object.values(GATEWAY_MODELS))].map((id) => ({
        api: "openai-responses" as const,
        baseUrl,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id,
        input: Array.of<"text">("text"),
        name: id,
        provider: PROVIDER,
        reasoning: true,
        ...LIMITS[id],
      })),
    })
  );

  const modelRefs = Object.fromEntries(
    Object.entries(GATEWAY_MODELS).map(([name, modelId]) => [
      name,
      { modelId, provider: PROVIDER },
    ])
  );

  return {
    declared: declaredThinkingOf(models, modelRefs, THINK_DEFAULT.thinking),
    defaults: THINK_DEFAULT,
    modelRefs,
    models,
    registry: createRegistry(),
    storageFor,
    streamFor: (runId) => ({
      metadata: { [RUN_CACHE_KEY]: promptCacheKeyOf(runId) },
    }),
  };
};
