import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { thinkingLevels } from "@mischief/core";
import type { AgentConfig, ThinkReceipt } from "@mischief/core";

type Thinking = NonNullable<AgentConfig["thinking"]>;

export interface ThinkDefaults {
  readonly model: string;
  readonly thinking: Thinking;
}

export interface Requested {
  readonly from: ThinkReceipt["requested"]["from"];
  readonly model: string;
  readonly thinking: Thinking;
  readonly thinkingFrom: NonNullable<ThinkReceipt["requested"]["thinkingFrom"]>;
}

const above = (level: Thinking, ceiling: Thinking) =>
  thinkingLevels.indexOf(level) > thinkingLevels.indexOf(ceiling);

const thinkingOf = (
  agent: AgentConfig,
  defaults: ThinkDefaults | undefined,
  ceiling: Thinking
) => {
  if (agent.thinking !== undefined) {
    return { thinking: agent.thinking, thinkingFrom: "plan" as const };
  }

  const fallback = defaults?.thinking ?? "low";

  return above(fallback, ceiling)
    ? { thinking: ceiling, thinkingFrom: "envelope" as const }
    : { thinking: fallback, thinkingFrom: "default" as const };
};

export const requestedOf = (
  agent: AgentConfig,
  defaults: ThinkDefaults | undefined,
  ceiling: Thinking
): Requested => ({
  from: agent.model === undefined ? "default" : "plan",
  model: agent.model ?? defaults?.model ?? "",
  ...thinkingOf(agent, defaults, ceiling),
});

const servedAs = (served: string | undefined, modelId: string) =>
  served === undefined ||
  served === modelId ||
  served.startsWith(`${modelId}-`);

const answerOf = (messages: readonly Message[] | undefined) =>
  (messages ?? []).findLast(
    (message): message is AssistantMessage => message.role === "assistant"
  );

const NO_USAGE = { cacheRead: 0, input: 0, output: 0, totalTokens: 0 };

const tokensOf = ({
  cacheRead,
  input,
  output,
  totalTokens,
}: typeof NO_USAGE) => ({
  cacheRead,
  input,
  output,
  total: totalTokens,
});

const effectiveOf = (answer: AssistantMessage) => ({
  model: answer.responseModel ?? answer.model,
  thinking: answer.providerThinkingLevel ?? answer.thinkingLevel ?? null,
});

const matchedOf = (
  answer: AssistantMessage,
  modelId: string,
  thinking: string
) =>
  servedAs(answer.responseModel, modelId) &&
  (answer.providerThinkingLevel === undefined ||
    answer.providerThinkingLevel === thinking);

const requestedFields = ({
  from,
  model,
  thinking,
  thinkingFrom,
}: Requested) => ({ from, model, thinking, thinkingFrom });

export const receiptOf = (
  requested: Requested,
  modelId: string,
  messages: readonly Message[] | undefined
): ThinkReceipt => {
  const answer = answerOf(messages);

  if (answer === undefined) {
    return {
      effective: { model: null, thinking: null },
      latencyMs: null,
      matched: false,
      requested: requestedFields(requested),
      tokens: tokensOf(NO_USAGE),
    };
  }

  return {
    effective: effectiveOf(answer),
    latencyMs:
      answer.durationMs === undefined ? null : Math.round(answer.durationMs),
    matched: matchedOf(answer, modelId, requested.thinking),
    requested: requestedFields(requested),
    tokens: tokensOf(answer.usage),
  };
};
