export const capturedHeaders = {
  accept: "application/json",
  "accept-encoding": "gzip, deflate",
  "anthropic-beta":
    "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,thinking-token-count-2026-05-13,effort-2025-11-24",
  "anthropic-dangerous-direct-browser-access": "true",
  "anthropic-version": "2023-06-01",
  authorization: "Bearer proxy",
  connection: "keep-alive",
  "content-type": "application/json",
  host: "192.0.2.1:28012",
  "user-agent": "claude-cli/2.1.321 (external, sdk-cli)",
  "x-app": "cli",
  "x-claude-code-session-id": "fixture-session",
  "x-stainless-arch": "x64",
  "x-stainless-lang": "js",
  "x-stainless-os": "Linux",
  "x-stainless-package-version": "0.3.321",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v24.18.0",
  "x-stainless-timeout": "600",
};

export const capturedBody = {
  context_management: { edits: [] },
  max_tokens: 128_000,
  messages: [
    {
      content: [{ text: "List the checked-out repository.", type: "text" }],
      role: "user",
    },
    {
      content: [
        {
          id: "tool-1",
          input: { path: "/work" },
          name: "mcp__custom-tools__ls",
          type: "tool_use",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          content: "src\npackage.json",
          tool_use_id: "tool-1",
          type: "tool_result",
        },
      ],
      role: "user",
    },
  ],
  metadata: { user_id: "fixture-user" },
  model: "claude-opus-5-5",
  output_config: { effort: "xhigh" },
  stream: true,
  system: [
    { text: "Fixture system block one.", type: "text" },
    { text: "Fixture system block two.", type: "text" },
    { text: "Fixture system block three.", type: "text" },
  ],
  thinking: { display: "summarized", type: "adaptive" },
  tools: [
    ...["bash", "find", "grep", "ls", "read"].map((tool) => ({
      description: `Fixture Pi ${tool} tool`,
      input_schema: { properties: {}, type: "object" },
      name: `mcp__custom-tools__${tool}`,
    })),
    {
      defer_loading: true,
      description:
        "Reserved placeholder that keeps deferred tool loading active; never call this tool.",
      input_schema: { properties: {}, type: "object" },
      name: "DeferredToolPlaceholder",
    },
  ],
};
