#!/usr/bin/env node
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This process fixture records the actual child stdin and empty working directory.
import { readFileSync, readdirSync } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This process fixture reads the child-specific settings path.
import path from "node:path";

import { Schema } from "effect";

const input = readFileSync(0, "utf-8");

const agentDir = Schema.decodeUnknownSync(Schema.String)(
  process.env.PI_CODING_AGENT_DIR
);

const text = JSON.stringify({
  agentDir,
  args: process.argv.slice(2),
  cwd: process.cwd(),
  debug: process.env.CLAUDE_BRIDGE_DEBUG,
  files: readdirSync(process.cwd()),
  inheritedOwner: process.env.MUSTER_OWNER_NAME ?? null,
  input,
  maxTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  ratking: process.env.RATKING_NAME,
  settings: Schema.decodeSync(Schema.fromJsonString(Schema.Json))(
    readFileSync(path.join(agentDir, "settings.json"), "utf-8")
  ),
});

process.stderr.write(`diagnostic must not be logged: ${input}`);

process.stdout.write(
  `${JSON.stringify({
    message: {
      content: [{ text, type: "text" }],
      role: "assistant",
      stopReason: "stop",
      usage: { cacheRead: 3, cacheWrite: 4, input: 1, output: 2 },
    },
    type: "message_end",
  })}\n`
);
