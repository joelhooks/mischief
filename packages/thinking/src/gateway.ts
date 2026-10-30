// @effect-diagnostics asyncFunction:off -- pi-ai resolves provider auth and rewrites payloads through async callbacks.
import type {
  ProviderStreams,
  StreamOptions,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import type { ModelRef } from "@earendil-works/pi-durable";
import { WORKSPACE_TOOLS } from "@mischief/core";
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

export const THINK_STREAM_TIMEOUT_MS = 1_440_000;

export const gatewayStreamOptions = (
  options?: StreamOptions,
  fetch?: StreamOptions["fetch"]
): StreamOptions => {
  const next: StreamOptions = {
    ...options,
    timeoutMs: options?.timeoutMs ?? THINK_STREAM_TIMEOUT_MS,
  };

  if (fetch !== undefined) {
    next.fetch = fetch;
  }

  return keyed(next);
};

const gatewayStreams = (
  api: ProviderStreams,
  fetch: StreamOptions["fetch"]
): ProviderStreams => {
  const optionsOf = (options: StreamOptions | undefined) =>
    gatewayStreamOptions(options, fetch);

  return {
    ...api,
    stream: (model, context, options) =>
      api.stream(model, context, optionsOf(options)),
    streamSimple: (model, context, options) =>
      api.streamSimple(model, context, optionsOf(options)),
  };
};

export interface GatewayEndpoint {
  readonly apiKey: Redacted.Redacted;
  readonly baseUrl: string;
  readonly fetch?: StreamOptions["fetch"];
}

export interface GatewayConfig extends GatewayEndpoint {
  readonly opusBridge?: GatewayEndpoint | undefined;
  readonly workspaceBridge?: GatewayEndpoint | undefined;
}

export const opusBridgeFrom = (
  url: string | undefined,
  key: string | undefined
): GatewayEndpoint | undefined =>
  url === undefined ||
  url.trim() === "" ||
  key === undefined ||
  key.trim() === ""
    ? undefined
    : { apiKey: Redacted.make(key), baseUrl: url };

const opusProvider = ({ apiKey, baseUrl, fetch }: GatewayEndpoint) =>
  createProvider({
    api: gatewayStreams(openAIResponsesApi(), fetch),
    auth: {
      apiKey: {
        name: "Mischief Opus bridge key",
        resolve: async () =>
          await Promise.resolve({
            auth: {
              apiKey: Redacted.value(apiKey),
              headers: { Authorization: `Bearer ${Redacted.value(apiKey)}` },
            },
          }),
      },
    },
    baseUrl,
    id: "claude-bridge",
    models: [
      {
        api: "openai-responses",
        baseUrl,
        contextWindow: 1_000_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "claude-opus-5-5",
        input: ["text"],
        maxTokens: 128_000,
        name: "Claude Opus 5.5 review bridge",
        provider: "claude-bridge",
        reasoning: true,
        thinkingLevelMap: {
          max: "max",
          minimal: null,
          off: null,
          xhigh: "xhigh",
        },
      },
    ],
  });

export const gatewayThinkerOptions = (
  storageFor: PiThinkerOptions["storageFor"],
  { apiKey, baseUrl, fetch, opusBridge, workspaceBridge }: GatewayConfig
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

  if (
    opusBridge !== undefined &&
    opusBridge.baseUrl.trim() !== "" &&
    Redacted.value(opusBridge.apiKey).trim() !== ""
  ) {
    models.setProvider(opusProvider(opusBridge));
  }

  const opus = models.getModel("claude-bridge", "claude-opus-5-5");
  const opusRef = { modelId: "claude-opus-5-5", provider: "claude-bridge" };

  const modelRefs: Record<string, ModelRef> = Object.fromEntries(
    Object.entries(GATEWAY_MODELS).map(([name, modelId]) => [
      name,
      { modelId, provider: PROVIDER },
    ])
  );

  if (opus !== undefined) {
    modelRefs.opus = opusRef;
    modelRefs["claude-opus-5-5"] = opusRef;
  }

  return {
    declared: {
      ...declaredThinkingOf(models, modelRefs, THINK_DEFAULT.thinking),
      exhaustive: true,
    },
    defaults: THINK_DEFAULT,
    modelRefs,
    models,
    registry: createRegistry(),
    storageFor,
    streamFor: (runId) => ({
      metadata: { [RUN_CACHE_KEY]: promptCacheKeyOf(runId) },
    }),
    workspaceModelRef:
      workspaceBridge === undefined
        ? undefined
        : (agent, ref) => {
            const source = models.getModel(ref.provider, ref.modelId);
            const { workspace } = agent;

            if (source === undefined || workspace === undefined) {
              return ref;
            }

            const tools = (agent.tools ?? []).filter((tool) =>
              WORKSPACE_TOOLS.some((name) => name === tool)
            );

            const provider = `workspace-${encodeURIComponent(JSON.stringify([ref, workspace, tools]))}`;

            const bridgeUrl = workspaceBridge.baseUrl.replace(
              /\/responses\/?$/u,
              ""
            );

            const api = gatewayStreams(
              openAIResponsesApi(),
              workspaceBridge.fetch
            );

            const withWorkspace = (
              options: StreamOptions | undefined
            ): StreamOptions => ({
              ...options,
              onPayload: async (payload, model) => {
                const prior =
                  (await options?.onPayload?.(payload, model)) ?? payload;

                return isPayload(prior)
                  ? { ...prior, tools, workspace }
                  : prior;
              },
            });

            models.setProvider(
              createProvider({
                api: {
                  ...api,
                  stream: (model, context, options) =>
                    api.stream(model, context, withWorkspace(options)),
                  streamSimple: (model, context, options) =>
                    api.streamSimple(model, context, withWorkspace(options)),
                },
                auth: {
                  apiKey: {
                    name: "Mischief workspace bridge key",
                    resolve: async () =>
                      await Promise.resolve({
                        auth: {
                          apiKey: Redacted.value(workspaceBridge.apiKey),
                          headers: {
                            Authorization: `Bearer ${Redacted.value(workspaceBridge.apiKey)}`,
                          },
                        },
                      }),
                  },
                },
                baseUrl: bridgeUrl,
                id: provider,
                models: [{ ...source, baseUrl: bridgeUrl, provider }],
              })
            );

            return { modelId: ref.modelId, provider };
          },
  };
};
