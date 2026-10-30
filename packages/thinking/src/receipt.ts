import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { capThinking } from "@mischief/core";
import type { AgentConfig, ThinkReceipt, ThinkingLevel } from "@mischief/core";

type Thinking = ThinkingLevel;

export interface ThinkDefaults {
  readonly model: string;
  readonly thinking: Thinking;
}

export interface Requested {
  readonly agent: AgentConfig;
  readonly from: ThinkReceipt["requested"]["from"];
  readonly model: string;
  readonly thinking: Thinking;
  readonly thinkingFrom: NonNullable<ThinkReceipt["requested"]["thinkingFrom"]>;
}

const thinkingOf = (
  agent: AgentConfig,
  defaults: ThinkDefaults | undefined,
  ceiling: Thinking
) => {
  if (agent.thinking !== undefined) {
    return { thinking: agent.thinking, thinkingFrom: "plan" as const };
  }

  const fallback = defaults?.thinking ?? "low";
  const thinking = capThinking(fallback, ceiling);

  return {
    thinking,
    thinkingFrom:
      thinking === fallback ? ("default" as const) : ("envelope" as const),
  };
};

export const requestedOf = (
  agent: AgentConfig,
  defaults: ThinkDefaults | undefined,
  ceiling: Thinking
): Requested => ({
  agent,
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

const NO_USAGE = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
  totalTokens: 0,
};

const tokensOf = ({
  cacheRead,
  cacheWrite,
  input,
  output,
  totalTokens,
}: typeof NO_USAGE) => ({
  cacheRead,
  cacheWrite,
  input,
  output,
  total: totalTokens,
});

const effectiveOf = (answer: AssistantMessage, sent: Thinking) => ({
  model: answer.responseModel ?? answer.model,
  thinking: answer.providerThinkingLevel ?? sent,
});

const matchedOf = (
  answer: AssistantMessage,
  modelId: string,
  thinking: string,
  sent: Thinking
) =>
  servedAs(answer.responseModel, modelId) &&
  (answer.providerThinkingLevel ?? sent) === thinking;

const requestedFields = ({
  from,
  model,
  thinking,
  thinkingFrom,
}: Requested) => ({ from, model, thinking, thinkingFrom });

export const receiptOf = (
  requested: Requested,
  modelId: string,
  sent: Thinking,
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
    effective: effectiveOf(answer, sent),
    latencyMs:
      answer.durationMs === undefined ? null : Math.round(answer.durationMs),
    matched: matchedOf(answer, modelId, requested.thinking, sent),
    requested: requestedFields(requested),
    tokens: tokensOf(answer.usage),
  };
};
