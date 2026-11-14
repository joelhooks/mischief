# Workspace bridge

A read-only checkout adapter for workspace thinks. The bridge accepts the model-bridge Responses contract plus `workspace: { repo, sha }` and `tools`, then returns the same Responses SSE events.

These definitions do not create a Docker network, slice, firewall rule or unit, and the units are not registered with the infrastructure stack. Local image builds do not prove peon-network execution or live provider behavior; those proofs remain rollout work.

## Processes

- `dist/main.js`: authenticated Responses bridge on loopback, port 28011.
- `dist/proxy-main.js`: keyless cell-facing Responses/Messages proxy on the peon network gateway, port 28012.

Sol uses **OpenAI Responses** through the Codex pool, unchanged. Only `POST /v1/responses` without a query string reaches that route. The proxy replaces the bearer with its host-only key, preserves Pi's identity and session headers, adds `X-Cliproxy-Client: mischief/peons`, and preserves successful stream bytes. It refuses unknown top-level fields, hosted tools, `previous_response_id` and `background` (even false). Tools must be Pi function definitions for read, grep, find, ls and bash; custom/grammar tools and deferred tool loading are refused on this route.

Opus uses **Anthropic Messages** through `claude-bridge`, the fleet's standard Pi provider backed by Claude Code's Agent SDK. Pi supplies the tools through in-process MCP; Claude Code's own tools stay off. The earlier Anthropic 400 came from the wrong provider configuration, not a reason to disguise prompts or identity headers. Only `POST /v1/messages`, with no query or exactly `?beta=true`, reaches this route. The proxy replaces authorization with the host-only bearer and forwards the other captured headers, original body text and successful stream bytes unchanged. It does not add the Responses client header. Messages uses Node HTTP rather than Fetch, and disables outbound trace propagation, so the transport does not add Fetch metadata or trace headers. It forwards upstream status, content type, content encoding, unchanged content length, request-id and anthropic-ratelimit diagnostics with the raw bytes. Hop-by-hop headers are dropped. Sol keeps its existing Fetch transport. The two routes share admission, retries and error bounds.

Eight proxy calls may remain open at once. A ninth receives 503. Before returning bytes, the proxy retries 429, 529, 503 and `overloaded_error` responses after 2, 4 and 8 seconds, then returns the fourth response. It bounds buffered error bodies to 64 KiB. After a successful stream starts, errors pass through without replaying the request.

## Host configuration

Declare values in the private environment files referenced by the unit definitions. `.env.schema` contains declarations, not credentials.

| Variable | Meaning |
| --- | --- |
| `MISCHIEF_WORKSPACE_BRIDGE_KEY` | Shared bridge/worker bearer, separate from provider credentials |
| `MISCHIEF_WORKSPACE_MIRRORS` | JSON map from `owner/repo` to read-only HTTPS walgit URL; its keys are this bridge's allowlist |
| `MISCHIEF_WORKSPACE_WALGIT_HOST` | Exact allowed mirror host, including a port if required |
| `MISCHIEF_WORKSPACE_EXPORTS_ROOT` | Dedicated absolute cache directory owned by the bridge, without symlinks |
| `MISCHIEF_WORKSPACE_IMAGE` | Image reference with a lowercase SHA-256 digest, never a tag alone |
| `MISCHIEF_PEON_CLIPROXY_URL` | Dedicated provider base URL, without `/v1/responses` or `/v1/messages` |
| `MISCHIEF_PEON_CLIPROXY_KEY` | Provider key; proxy process only |
| `MISCHIEF_PEON_MODELS` | Exactly `["gpt-6.1-sol","claude-opus-5-5"]`, in either order, with no duplicates |

The worker's comma-separated `MISCHIEF_WORKSPACE_REPOS` is separate. A worker/bridge allowlist mismatch fails closed. Mirror URLs must use HTTPS on the configured walgit host, without credentials, query strings or fragments. Read-only Git credentials belong in the host's system Git configuration; the runner does not inherit the operator's environment or HOME. Neither mirrors nor Git configuration enter a cell.

The bridge binds its exclusive loopback listener before constructing the export service or sweeping containers. A second bridge cannot sweep the first bridge's live calls. Run one bridge owner for this cache and Docker label.

## Cache and receipts

The remote Git repository owns source history. The bridge is the only writer of the derived mirror, SHA-addressed export and last-use metadata. Removing the dedicated cache and fetching the approved commit rebuilds these copies. Callers never choose a remote URL or host path.

Preparation is serialized. A mirror fetch verifies `<sha>^{commit}` even for a cached export. A new export comes from `git archive`, with a SHA-256 digest of that archive. Git symlinks and submodules are refused before extraction. Every exported path is checked for symlink traversal; files become world-readable and read-only, directories traversable and read-only. Metadata opens reject symlinks too. Each running call holds an export lease.

At boot, before calls, and hourly, GC deletes exports unused for 24 hours, but never an active lease. It also removes old interrupted export/mirror staging directories. Orphan containers are found by the fixed label and removed only when not owned by a live call. The cache checks its combined mirror/export/staging usage against 50 GB (50000000000 bytes) before admission and after growth. This is an application watermark, not a filesystem quota: a single Git transfer can cross it before the next check. Provisioned host storage remains a rollout concern.

`workspace_receipt` structured logs go to the service journal. They contain repo, SHA, export digest, container name, observed tool-call count, wall time, collected exit code (null if interrupted before collection), actual peon model, requested thinking, Sol's applied thinking and the output-token ceiling. For Claude, the proxy logs `peon_provider_receipt` with the provider model and the observed `output_config.effort` (null if absent). The sandbox does not claim that the requested Claude thinking level was applied. They contain neither prompts, file contents, remote URLs nor keys. Accounting sums all assistant turns, including tool-use turns, before the shared final-answer decoder emits Responses events.

The call machine has `running` and `settled` states. Its 15-minute deadline covers export preparation, startup priming, Docker execution and output collection. Scope finalizers force-remove the generated container name on completion, refusal, timeout or client cancellation. Failed teardown logs an alarm; the next orphan sweep retries it.

Eight calls are admitted; a ninth gets 503 with `retry-after`, never an unbounded queue. `/healthz` reports admitted calls as `running` and zero external `queued` calls. Admitted calls can still be preparing an export or waiting for startup cache priming. During the configured maintenance interval, calls receive 503 without starting work.

## Servo argv review

The exact argv is checked in at `test/__snapshots__/sandbox.test.ts.snap`. The runner interface has a fake; tests do not invoke Docker.

The reviewed command retains the fixed internal network, slice parent, read-only mount/root, 256 MiB tmpfs, dropped capabilities, no-new-privileges, UID/GID 65534, 2 GiB memory/swap, one CPU and 256 PIDs. No input can add a Docker flag, network or mount.

Approved additions to the original fixed template:

| Part | Reason |
| --- | --- |
| SHA | Selects the immutable export below the configured root |
| Generated `--name mischief-peon-<uuid>` | Validated bridge-generated identity for exact-name force-removal; never supplied by the caller |
| Fixed `--label mischief.peon=1` | Finds orphans after a bridge crash |
| Fixed `--interactive`, no TTY | Carries the capped prompt over stdin rather than argv |
| Fixed `--init` | Reaps shell children and forwards termination signals |
| Fixed `--log-driver none` | Keeps attached stdout streaming without retaining repository text in daemon logs |
| `--thinking` | Closed Responses enum mapped to supported Pi levels; none/minimal become low (Sol disables off), and low/medium/high/xhigh/max pass through using the explicit Sol thinking map; requested and applied levels are recorded |

Sol's reviewed argv remains byte-identical. The second Servo snapshot adds only `-e /opt/claude-bridge/src/index.ts` after `--no-extensions` and selects `--model claude-bridge/claude-opus-5-5`. Sandbox flags, tools, skills, templates and system prompt stay unchanged.

The gateway contract is exercised through the real `gatewayThinkerOptions` workspace path in `test/gateway-contract.test.ts`, for every planner thinking level. At `off`, the worker sends effort `none`; omitted reasoning also defaults to `none`. Both become Pi `--thinking low`, Sol's minimum wire effort. The planner's `minimal` level arrives as effort `minimal` and also becomes `low`. The worker's existing Sol metadata clamps xhigh/max to high before sending; direct bridge requests can use xhigh/max because the image declares them. Unknown fields remain errors, and the ordinary Opus bridge request schema is unchanged.

V1 requires exactly the five shell tools in the request. A subset or duplicate set is refused rather than silently granting more tools. The bridge accepts `max_output_tokens` from 16 through 128000, including the worker's current Sol ceiling of 32000. Pi 0.86.1's CLI has no per-call output-token flag, so the peon still runs at the baked model ceiling of 128000, potentially context-clamped by Pi. Receipts record both `requestedOutputTokens` and `outputTokenCap`; this is not enforcement of the caller's smaller cap. Changing ordinary Sol gateway metadata is outside this packet.

The system prompt, tool list, cwd and agent-directory paths are fixed across leaves. The first admitted leaf becomes the cache leader once per bridge process start; there is no re-election. Followers wait for its first successful assistant `message_end` on stdout, which follows the first model response, or for that leaf's cleanup if it fails. Split stdout chunks are supported. No timer guesses cache readiness.

The gateway resolves planner alias `sol` to model ID `gpt-6.1-sol` before building the workspace request. The bridge accepts these two aliases and records `peon/gpt-6.1-sol`. It accepts `opus` and `claude-opus-5-5` as `claude-bridge/claude-opus-5-5`. Other models fail before export or Docker work, including other Claude IDs. Provider errors name the provider and observed HTTP status and include a credential-redacted diagnostic capped at 512 characters; a provider 4xx is not labelled a model refusal.

Pi 0.86.1's Anthropic catalog does not contain `claude-opus-5-5`. The pinned bridge uses Pi's custom-model-ID fallback, which can inherit another model's thinking map. No extra `models.json` entry is baked for Claude. The custom-ID warning goes to stderr, which the runner collects separately from JSON stdout. The proxy's observed effort is authoritative, not an inferred mapping. Updating Pi's catalog is a separate packet.

Pi is not patched. Its Responses provider sends `store: false`, full transcript input, native function tools, a prompt cache key and session affinity headers. A real provider cache hit still needs rollout proof.

## Provider feature boundary

The source audit reads `dist/api/openai-responses.js` and `openai-responses-shared.js` from pi-ai inside the digest-pinned Pi 0.86.1 base image. `createClient` uses OpenAI's SDK with `baseURL: model.baseUrl`; `client.responses.create` appends `/responses`, so the baked base URL ends in `/v1`. `buildParams` sends model, input, stream, store, optional max_output_tokens, temperature, service_tier, prompt_cache_key, prompt_cache_retention, reasoning, include, tool_choice and tools. Neither previous_response_id nor background is needed. Explicit prompt-cache mode and additional/tool-search/grammar compat features are not enabled in this image and are not admitted by the proxy.

Headers are closed to HTTP transport headers, bearer, Node fetch transport metadata (`accept-language`, `sec-fetch-mode`), Pi User-Agent, `session_id`, `x-client-request-id`, and the OpenAI SDK's `x-stainless-{lang,package-version,os,arch,runtime,runtime-version,retry-count,timeout}` metadata. Feature headers, including OpenAI and Anthropic betas, are refused before upstream access. The proxy does not forward client transport routing or credentials.

`test/responses-provider.test.ts` drives the repository's real vendored pi-ai provider through the HTTP proxy and fake upstream for every applied thinking level, using the baked model configuration. The repository provider is 1.3.1-main.73f8de8, not the image's 0.86.1. Both use the same path, default headers and body fields for this configuration; the newer provider adds configuration-update handling outside this path. The image's real outgoing-request capture remains a rollout cross-check, not a claim made by the repository test.

### Closed Claude Messages route

The capture used bridge commit `743aaba5b85a3a788258fd1d1998b6dacc6e790c`, Claude Code 2.1.321 and SDK 0.3.321. `src/skills.ts` at that bridge revision defines MCP server `custom-tools`. The Claude Code binary defines `DeferredToolPlaceholder` with description `Reserved placeholder that keeps deferred tool loading active; never call this tool.`, `input_schema: {"type":"object","properties":{}}` and `defer_loading: true`. The proxy accepts that exact placeholder or the five `mcp__custom-tools__{read,grep,find,ls,bash}` definitions, with exactly name, description and input_schema. Every typed tool, unknown tool, extra tool key and connector is refused.

Header names and the exact beta string are closed to the captured Claude Code request. `anthropic-version` must be `2023-06-01`. Body keys are context_management, max_tokens, messages, metadata, model, output_config, stream, system, thinking and tools. The pinned Claude Code request builder can also send tool_choice and temperature: choice is auto/any/none or a named approved MCP tool, with optional disable_parallel_tool_use; temperature is finite and between 0 and 1. Metadata allows only user_id. Output config allows only effort (low/medium/high/xhigh/max). Speed and other feature switches are refused.

`test/messages.test.ts` feeds an independently authored capture-shaped fixture through the real HTTP router and proxy into a fake upstream. It checks exact headers, original body bytes, compressed and uncompressed stream bytes, SDK-like gzip decoding, both admitted targets, and extra beta/header/body/tool refusals. A separate loopback-upstream test uses the production Node HTTP transport and proves it adds neither Fetch metadata nor trace headers. It uses Web HTTP requests so the test client's Node Fetch metadata cannot silently widen the captured header set. Real Claude traffic still needs the desk's post-build capture.

## Image and rollout

Build context is this directory. Both `PI_IMAGE` and `CLAUDE_BRIDGE_IMAGE` must be **pinned by SHA-256 digest**. The Pi base must already contain Node, Pi, bash, rg, fd and find. Its binary gate also requires sh, env, mkdir, cp, chmod and which on the same fixed PATH the cell uses. The Dockerfile installs no packages and works with the legacy builder (`DOCKER_BUILDKIT=0`): a named bridge stage supplies `/opt/claude-bridge` through `COPY --from=bridge`.

The desk's bridge image is `mischief-claude-bridge@sha256:5a7a6c34db70821cc49f8e2c30db53e31fd6d4093e78314480a3e436532684bf`. Its recipe archives pi-claude-bridge commit `743aaba5b85a3a788258fd1d1998b6dacc6e790c` into `/opt/claude-bridge`, runs `npm ci --ignore-scripts --omit=dev` from that revision's lockfile with the Linux x64 Agent SDK package, and writes the full SHA to `/opt/claude-bridge/COMMIT`. The peon build gate checks that commit, the extension entrypoint, and offline `claude --version` with telemetry and nonessential traffic disabled.

```bash
DOCKER_BUILDKIT=0 docker build \
  --build-arg PI_IMAGE="$PI_IMAGE" \
  --build-arg CLAUDE_BRIDGE_IMAGE=mischief-claude-bridge@sha256:5a7a6c34db70821cc49f8e2c30db53e31fd6d4093e78314480a3e436532684bf \
  -t mischief-peon:claude-bridge apps/workspace-bridge
```

The desk owns that build and all live checks. Before deploying, back up `peon-proxy.env`, set its models to exactly `["gpt-6.1-sol","claude-opus-5-5"]`, and configure a host provider serving both routes. Capture real peon traffic against these allowlists before rollout. Then deploy through the owning workflow, run `confine.sh`, and run one approved `opus` workspace leaf through the client. Keep a known-good image and env backup for rollback.

The entrypoint copies baked models, settings and `claude-bridge.json` to `/tmp/peon`, then executes Pi under `env -i`. The bridge config places `plan: max` and `pathToClaudeCodeExecutable` under `provider`, pointing at `/opt/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`. For every model the clean environment contains the cell-facing Anthropic proxy URL, `ANTHROPIC_AUTH_TOKEN=proxy` (not a secret), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1` and `CLAUDE_CODE_MAX_RETRIES=1`. The host proxy owns the outer retry schedule. HOME and the agent directory are `/tmp/peon`; no host HOME or provider secret is inherited. Only the private tmpfs copies of these three configuration files are changed to mode 0600, so Pi can update settings; the baked `/opt/peon` assets remain 0444. The baked model uses `openai-responses`, provider `peon`, model `gpt-6.1-sol`, and the literal placeholder `proxy`; its 500000-token context and 128000 output maximum match the fleet Sol entry. The explicit thinking map enables xhigh/max and disables off; pinned Pi clamps an off request to minimal, whose wire effort is low. Grammar/additional/tool-search compat switches are deliberately not copied from the fleet entry. The host proxy replaces that placeholder. Both root and `/work` remain read-only. Writable configuration and scratch disappear with the tmpfs.

The original binary and writable-path audit targets coding agent version 0.86.1, under `node_modules/@earendil-works/pi-coding-agent/dist/` in the base image. The Responses source audit reads that same pinned image, not the newer repository dependency. The same build check prints `pi --version` and refuses anything except 0.86.1. Changing the base's Pi version requires re-running the binary and writable-path audit and updating that gate together. This is not proof that an unbuilt image runs.

| Tool | Fixed binary dependency | Source evidence relative to that directory |
| --- | --- | --- |
| read | Node filesystem APIs; no external command | `core/tools/read.js` lines 1–2 and 20; image handling calls Photon through `utils/image-convert.js` and `utils/image-resize-core.js`, not a CLI |
| ls | Node filesystem APIs; no external command | `core/tools/ls.js` lines 1 and 19–20 |
| grep | rg | `core/tools/grep.js` lines 52 and 101 |
| find | fd | `core/tools/find.js` lines 119 and 161; `utils/tools-manager.js` also recognizes fdfind, but this image check requires fd |
| bash | bash; which for PATH fallback | `core/tools/bash.js` lines 50 and 120; `utils/shell.js` lines 38 and 94–101; Linux process-tree cleanup uses Node signals at lines 203–208, not an external kill command |

Commands a model chooses inside bash are not a finite dependency list. The image check covers the fixed tool infrastructure and the entrypoint commands, not arbitrary utilities.

`config.js` lines 421–426 and 436–449 root agent files below `PI_CODING_AGENT_DIR`. `core/settings-manager.js` lines 60–61 and 108 place and write settings there. `main.js` lines 284–285 select in-memory sessions for `--no-session`. There is one additional writable area: output spills use the OS temporary directory, including `/tmp/pi-bash-*.log` in `core/tools/output-accumulator.js` lines 6–8 and `core/bash-executor.js` lines 34–35. The existing whole `/tmp` tmpfs already covers those files; no extra mount is needed.

The image test executes the real entrypoint with its absolute filesystem roots and proxy address relocated into a disposable fixture. It verifies that baked 0444 assets become private writable 0600 copies, HOME points at the private copy directory, an incoming key is discarded, and Docker mounts only the readonly checkout and `/tmp` tmpfs. It does not run Docker or Pi from the real image.

Before go-live, obtain Servo's argv/image review, create the separately owned slice/network/firewall prerequisites, provision read-only mirror access and the dedicated provider key, build and record the resulting workspace image digest, and run one pinned public-repo leaf before a real batch. Prove cancellation, deadline removal, a restart orphan sweep, network isolation and a warm-cache follower. None of those live actions is authorized by this code packet.

### Go-live image completion proof

Run this Bash script from the built repository root only after the image and host prerequisites are approved. Point the host Responses proxy at a controlled fake Responses upstream, or use the separately authorized real provider. Keep the baked cell URL unchanged: do not mount replacement configuration or pass a provider key into the cell. Set `SHA` to an already prepared export, `MISCHIEF_WORKSPACE_IMAGE` to the approved runtime digest, and `PROOF_ROOT` to an existing private artifact directory. The script uses the reviewed snapshot argv, with the prepared export path, generated name and medium thinking. The outer timeout and output redirection do not add Docker flags.

```bash
set -euo pipefail
: "${SHA:?Set an already prepared commit SHA}"
: "${MISCHIEF_WORKSPACE_EXPORTS_ROOT:?Set the bridge cache root}"
: "${MISCHIEF_WORKSPACE_IMAGE:?Set the approved runtime image digest}"
: "${PROOF_ROOT:?Set an existing private artifact directory}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$MISCHIEF_WORKSPACE_IMAGE" =~ ^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[0-9a-f]{64}$ ]]
exports_root=$(realpath -- "$MISCHIEF_WORKSPACE_EXPORTS_ROOT/exports")
export_path=$(realpath -- "$exports_root/$SHA")
[[ "$export_path" == "$exports_root/$SHA" && -d "$export_path" ]]
name="mischief-peon-$(node -e 'console.log(require("node:crypto").randomUUID())')"
umask 077
proof_dir=$(mktemp -d "${PROOF_ROOT%/}/peon-image.XXXXXX")
cleanup() {
  remaining=$(docker ps -aq --filter "name=^${name}$") || return 1
  if [[ -n "$remaining" ]]; then
    docker rm --force "$name" >/dev/null
  fi
}
trap cleanup EXIT
printf '%s\n' '{"instructions":"Return exactly PEON_PROBE_OK. Do not call tools.","messages":[{"role":"user","content":"Confirm the cell starts."}]}' |
  timeout --signal=TERM --kill-after=10s 15m docker run \
    --rm --init --log-driver none --interactive \
    --name "$name" --label mischief.peon=1 \
    --network mischief-peons --cgroup-parent mischief-peons.slice \
    --read-only --tmpfs /tmp:size=256m --cap-drop ALL \
    --security-opt no-new-privileges --user 65534:65534 \
    --memory 2g --memory-swap 2g --cpus 1 --pids-limit 256 \
    -v "$export_path:/work:ro" "$MISCHIEF_WORKSPACE_IMAGE" \
    pi -p --no-session --tools read,grep,find,ls,bash \
    --no-extensions --no-skills --no-prompt-templates \
    --model peon/gpt-6.1-sol --thinking medium \
    --system-prompt 'You are a read-only code review peon. The input is a JSON envelope with instructions and text messages. Follow those instructions. Inspect /work with read, grep, find, ls and bash. Quote file paths and reference evidence. Do not attempt writes or network access.' \
    --mode json >"$proof_dir/stdout.jsonl" 2>"$proof_dir/stderr.log"
node --input-type=module - "$proof_dir/stdout.jsonl" <<'NODE'
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { workspaceCompletion } from "./apps/workspace-bridge/dist/pi-output.js";
const completion = await Effect.runPromise(
  workspaceCompletion(readFileSync(process.argv[2], "utf8"), 0)
);
if (completion.stopReason !== "stop" || completion.text.trim() !== "PEON_PROBE_OK") {
  throw new Error("Pi did not complete the probe. Inspect the private artifacts.");
}
console.log("PASS: pi -p completed under the reviewed argv.");
NODE
printf 'Private proof artifacts: %s\n' "$proof_dir"
```

The artifacts can contain repository text. Keep them private; do not attach them to a public PR. This proves basic completion only. The separate cancellation, deadline, orphan-sweep, process-reaping, daemon-log and network-isolation checks still need go-live evidence. No real-image execution has been performed by the tests in this packet.

Keep workspace routing off until those proofs pass. Rollback is to keep or turn routing off, stop the two user services through the owning deploy workflow, and sweep only labeled peon containers. Mirrors and exports contain no authoritative state.
