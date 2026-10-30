import { Context } from "effect";

import { stepsOf } from "./doc-refs.js";
import type { AgentConfig, Plan } from "./schema.js";

export const WORKSPACE_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

export interface WorkspacePolicyConfig {
  readonly enabled: boolean;
  readonly repos: readonly string[];
}

export const WorkspacePolicy = Context.Reference<WorkspacePolicyConfig>(
  "@mischief/core/WorkspacePolicy",
  { defaultValue: () => ({ enabled: false, repos: [] }) }
);

export const workspacePolicyFrom = (
  flag: string | undefined,
  repos: string | undefined
): WorkspacePolicyConfig => ({
  enabled: flag === "on",
  repos: (repos ?? "")
    .split(",")
    .map((repo) => repo.trim())
    .filter(Boolean),
});

const agentErrors = (
  agent: AgentConfig,
  where: string,
  policy: WorkspacePolicyConfig
): readonly string[] => {
  const shell = (agent.tools ?? []).filter((tool) =>
    WORKSPACE_TOOLS.some((name) => name === tool)
  );

  const { workspace } = agent;

  if (workspace === undefined) {
    return shell.length === 0
      ? []
      : [
          `${where}.tools: shell tools (${shell.join(", ")}) require agent.workspace so they run in a read-only checkout. Set agent.workspace to an allowed repo and a pinned 40-character lowercase hex sha, or remove those tools`,
        ];
  }

  return [
    ...(policy.enabled
      ? []
      : [
          `${where}.workspace: workspace execution is off on this host. Enable MISCHIEF_WORKSPACE=on before submitPlan, or remove agent.workspace and its shell tools`,
        ]),
    ...(policy.repos.includes(workspace.repo)
      ? []
      : [
          `${where}.workspace.repo: "${workspace.repo}" is not in MISCHIEF_WORKSPACE_REPOS. Use ${policy.repos.join(", ") || "a repo configured by the host"}, or add the repo to MISCHIEF_WORKSPACE_REPOS before submitPlan`,
        ]),
    ...(agent.tools !== undefined &&
    agent.tools.length === WORKSPACE_TOOLS.length &&
    WORKSPACE_TOOLS.every((tool) => agent.tools?.includes(tool) === true)
      ? []
      : [
          `${where}.tools: agent.workspace v1 grants the fixed shell tool set, so subsets and extra tools are refused. Set agent.tools to exactly read, grep, find, ls, bash in any order, and include all five in envelope.tools, or remove agent.workspace and its shell tools`,
        ]),
  ];
};

export const workspaceErrors = (plan: Plan, policy: WorkspacePolicyConfig) => [
  ...agentErrors(plan.defaults.agent, "defaults.agent", policy),
  ...stepsOf(plan.machine.states).flatMap(({ step, where }) =>
    step.kind === "think"
      ? agentErrors(
          { ...plan.defaults.agent, ...step.agent },
          `${where}.agent`,
          policy
        )
      : []
  ),
];
