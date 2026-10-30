import type { Completion } from "@mischief/model-bridge/protocol";

import type { WorkspaceRequest } from "../src/protocol.js";

export const sha = "0123456789abcdef0123456789abcdef01234567";

export const digest = "a".repeat(64);

export const image = `mischief/workspace@sha256:${digest}`;

export const name = "mischief-peon-01234567-89ab-4cde-8fab-0123456789ab";

export const request: WorkspaceRequest = {
  input: [{ content: "private review prompt", role: "user" }],
  model: "claude-opus-5-5",
  reasoning: { effort: "medium" },
  stream: true,
  tools: ["read", "grep", "find", "ls", "bash"],
  workspace: { repo: "example/review", sha },
};

export const completion: Completion = {
  stopReason: "stop",
  text: "verdict",
  usage: { cacheRead: 0, cacheWrite: 0, input: 1, output: 1 },
};

export const piOutput = [
  { toolName: "read", type: "tool_execution_start" },
  {
    message: {
      content: [{ text: "verdict", type: "text" }],
      role: "assistant",
      stopReason: "stop",
      usage: completion.usage,
    },
    type: "message_end",
  },
]
  .map((event) => JSON.stringify(event))
  .join("\n");
