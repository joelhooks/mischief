# Opus review bridge

This adapter runs text-only review calls through Pi's `claude-bridge` provider and Claude Code. It does not call Anthropic's Messages API directly.

## Routes

- `POST /v1/responses` accepts the text-only subset emitted by the pinned pi-ai Responses client. Requests require bearer authentication and `stream: true`.
- `GET /healthz` returns `inFlight` and `version`. It does not start a model call.

The request schema accepts text messages, including prior assistant text, and rejects unknown keys, images and tools. In addition to model, instructions, input, effort, cache key and output cap, it accepts the wire fields pi-ai sends: `store: false`, `include: ["reasoning.encrypted_content"]` and `reasoning.summary: "auto"`. Those compatibility fields do not enable storage or extra behavior.

The bridge waits for the child to exit before sending SSE headers. It then emits one text delta and the final usage. This keeps subprocess failures as HTTP errors rather than successful HTTP responses with broken streams. Cache-read and cache-write counts come from Pi's final assistant message.

Four calls may run at once. Further calls receive 429 and `retry-after`. Rate-limit failures also return 429. Upstream server and transport failures normalize to 500 so Mischief applies its existing retry-then-hold policy. Authentication and request failures return 4xx. A call past 1380 seconds returns 504, before the gateway's 1440-second timeout. The scoped process adapter terminates the child process group during cleanup.

## Configuration

The gateway exposes `opus` and `claude-opus-5-5` only when both `MISCHIEF_OPUS_BRIDGE_URL` and `MISCHIEF_OPUS_BRIDGE_KEY` are nonempty. The URL includes `/v1`. Gateway declarations are exhaustive: an unmapped model fails plan validation before execution. Other hosts retain their existing declaration behavior.

The bridge reads these variables:

| Variable | Purpose |
| --- | --- |
| `MISCHIEF_OPUS_BRIDGE_KEY` | Shared bearer key |
| `MISCHIEF_OPUS_PI_BIN` | Absolute Pi launcher path |
| `MISCHIEF_OPUS_CLAUDE_BIN` | Absolute Claude Code executable path |
| `MISCHIEF_OPUS_EXTENSION` | Absolute `claude-bridge` extension entry |
| `MISCHIEF_OPUS_CLIPROXY_URL` | Claude Code's proxy base URL |
| `MISCHIEF_OPUS_CLIPROXY_KEY` | Proxy client credential, separate from the bearer key |
| `MISCHIEF_OPUS_LISTEN_HOST` | Listener interface; defaults to loopback |
| `MISCHIEF_OPUS_LISTEN_PORT` | Listener port; defaults to 28010 |

Each bridge process creates a private agent directory containing retry-disabled settings and its `claude-bridge.json`. Each call gets a separate empty working directory. Prompts travel over stdin, never argv. The child receives an allowlisted environment, `RATKING_NAME=off`, disabled bridge debug logging, no extension discovery, only the explicit bridge extension, and no tools, skills or prompt templates. Logs contain counts, exit codes, status and duration, not prompts or stderr text.

The supported efforts are `low`, `medium`, `high`, `xhigh` and `max`. `off` and `minimal` are refused rather than silently remapped. The model declares a 1,000,000-token context and 128,000-token output limit, following [Anthropic's Opus 5.5 overview](https://platform.claude.com/docs/en/models/opus-5-5/overview) and [effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort). The output cap is passed to Claude Code through `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; its live truncation behavior remains a release proof, not a local-test claim.

## Deployment boundary

Nothing enables or deploys this service automatically. The celld stack declares its user unit only when the bridge URL is set. `MISCHIEF_OPUS_BRIDGE_ENTRY` names an already-built entry on that host. The unit reads a private `opus-bridge.env` under the instance's configuration directory. The operator must stage the built bridge and supply that file before applying the plan. Worker bearer keys stay in the private bindings file, never Alchemy state or plain deployment vars.

The bridge unit does not change celld's slice limits. It runs outside `mischief.slice` with its own cap: `MemoryHigh=3.5G`, `MemoryMax=4G` and no swap, shared by up to four Pi and Claude Code children. Start with a same-host loopback listener. The inspected celld fetch implementation delegates outbound HTTP to reqwest without a loopback/private-address filter. This is source evidence only: confirm `/healthz` from the actual deployed isolate before enabling reviews. A deployment on another host needs its own approved private route.

Rollback removes the gateway URL/key and redeploys the worker, then stops the bridge unit. This refuses new Opus plans; it does not silently route them to another model. Inspect in-flight reviews before stopping the bridge.

The release owner runs one fixed-diff `change-review@1` on `opus`, verifies the decoded verdict and exact quote, and checks refusal of an undeclared effort. No model call or deployment is part of the local suite.
