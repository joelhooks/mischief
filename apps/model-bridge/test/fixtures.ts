import type { Completion, ResponsesRequest } from "../src/protocol.js";

export const request: ResponsesRequest = {
  input: [{ content: "private review prompt", role: "user" }],
  model: "claude-opus-5-5",
  reasoning: { effort: "medium" },
  stream: true,
};

export const completion: Completion = {
  stopReason: "stop",
  text: "verdict",
  usage: { cacheRead: 0, cacheWrite: 0, input: 1, output: 1 },
};
