import { Context } from "effect";

import { stepsOf } from "./doc-refs.js";
import type { AgentConfig, Plan } from "./schema.js";
import { thinkingLevels } from "./schema.js";

export type ThinkingLevel = (typeof thinkingLevels)[number];

export interface ThinkingDeclaration {
  readonly fallback: ThinkingLevel;
  readonly models: Readonly<Record<string, readonly ThinkingLevel[]>>;
}

export const DeclaredThinking = Context.Reference<ThinkingDeclaration>(
  "@mischief/core/DeclaredThinking",
  { defaultValue: () => ({ fallback: "low", models: {} }) }
);

export const capThinking = (level: ThinkingLevel, ceiling: ThinkingLevel) =>
  thinkingLevels.indexOf(level) > thinkingLevels.indexOf(ceiling)
    ? ceiling
    : level;

interface Asked {
  readonly field: string;
  readonly from: "default" | "plan";
  readonly level: ThinkingLevel;
  readonly model: string;
  readonly subject: string;
  readonly where: string;
}

interface Asker {
  readonly agent: AgentConfig;
  readonly field: string;
  readonly subject: string;
  readonly where: string;
}

const askedBy = (
  plan: Plan,
  declaration: ThinkingDeclaration,
  { agent, field, subject, where }: Asker
): Asked => ({
  field,
  from: agent.thinking === undefined ? "default" : "plan",
  level:
    agent.thinking ??
    capThinking(declaration.fallback, plan.envelope.maxThinking),
  model: agent.model ?? plan.envelope.models[0],
  subject,
  where,
});

const askersOf = (plan: Plan): readonly Asker[] => {
  const { agent } = plan.defaults;
  const judged = plan.envelope.thresholds.think !== undefined;

  return [
    {
      agent,
      field: "defaults.agent",
      subject: "the plan's default agent",
      where: "defaults.agent",
    },
    ...stepsOf(plan.machine.states).flatMap(({ step, where }): Asker[] => {
      if (step.kind === "think") {
        return [
          {
            agent: { ...agent, ...step.agent },
            field: "its agent",
            subject: "this think",
            where,
          },
        ];
      }

      return step.kind === "judge" && judged
        ? [
            {
              agent,
              field: "defaults.agent",
              subject: "this judge's think rung, which runs defaults.agent,",
              where,
            },
          ]
        : [];
    }),
  ];
};

const declaring = (declaration: ThinkingDeclaration, level: ThinkingLevel) =>
  Object.entries(declaration.models)
    .filter(([, levels]) => levels.includes(level))
    .map(([name]) => name);

const refusal = (
  declaration: ThinkingDeclaration,
  { field, from, level, model, subject, where }: Asked,
  declared: readonly ThinkingLevel[]
) => {
  const source =
    from === "plan"
      ? `thinking "${level}"`
      : `thinking "${level}" (the host default "${declaration.fallback}", capped by envelope.maxThinking)`;

  const others = declaring(declaration, level);

  return `${where}: ${subject} asks model "${model}" for ${source}, which "${model}" does not declare, so the provider would silently get a lower level. "${model}" declares: ${declared.join(", ")}. Fix: set ${field}.thinking to one of those, or set ${field}.model to a model that declares "${level}" (${others.join(", ") || "none on this host"})`;
};

export const undeclaredThinking = (
  plan: Plan,
  declaration: ThinkingDeclaration
): readonly string[] =>
  askersOf(plan).flatMap((asker) => {
    const asked = askedBy(plan, declaration, asker);
    const declared = declaration.models[asked.model];

    return declared === undefined || declared.includes(asked.level)
      ? []
      : [refusal(declaration, asked, declared)];
  });
