# Workspace bridge

A read-only checkout adapter for workspace thinks. The bridge accepts the model-bridge Responses contract plus `workspace: { repo, sha }` and `tools`, then returns the same Responses SSE events.

These definitions do not create a Docker network, slice, firewall rule or unit, and the units are not registered with the infrastructure stack. Local image builds do not prove peon-network execution or live provider behavior; those proofs remain rollout work.

## Processes

- `dist/main.js`: authenticated Responses bridge on loopback, port 28011.
- `dist/proxy-main.js`: keyless cell-facing OpenAI Responses proxy on the peon network gateway, port 28012.

The proxy uses **OpenAI Responses** through the Codex pool, not Anthropic Messages or the text-only Opus bridge. Anthropic blocks Pi requests with its extra-usage requirement; no prompts or identity headers are disguised to evade that block. Only `POST /v1/responses` without a query string reaches the configured provider. The proxy replaces the bearer with its host-only key, preserves Pi's identity and session headers, adds `X-Cliproxy-Client: mischief/peons`, and preserves successful stream bytes. It refuses unknown top-level fields, hosted tools, `previous_response_id` and `background` (even false). Tools must be Pi function definitions for read, grep, find, ls and bash; custom/grammar tools and deferred tool loading are refused.

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
| `MISCHIEF_PEON_CLIPROXY_URL` | Dedicated provider base URL, without `/v1/responses` |
| `MISCHIEF_PEON_CLIPROXY_KEY` | Provider key; proxy process only |
| `MISCHIEF_PEON_MODELS` | JSON proxy model allowlist; defaults to `["gpt-6.1-sol"]` |

The worker's comma-separated `MISCHIEF_WORKSPACE_REPOS` is separate. A worker/bridge allowlist mismatch fails closed. Mirror URLs must use HTTPS on the configured walgit host, without credentials, query strings or fragments. Read-only Git credentials belong in the host's system Git configuration; the runner does not inherit the operator's environment or HOME. Neither mirrors nor Git configuration enter a cell.

The bridge binds its exclusive loopback listener before constructing the export service or sweeping containers. A second bridge cannot sweep the first bridge's live calls. Run one bridge owner for this cache and Docker label.

## Cache and receipts

The remote Git repository owns source history. The bridge is the only writer of the derived mirror, SHA-addressed export and last-use metadata. Removing the dedicated cache and fetching the approved commit rebuilds these copies. Callers never choose a remote URL or host path.

Preparation is serialized. A mirror fetch verifies `<sha>^{commit}` even for a cached export. A new export comes from `git archive`, with a SHA-256 digest of that archive. Git symlinks and submodules are refused before extraction. Every exported path is checked for symlink traversal; files become world-readable and read-only, directories traversable and read-only. Metadata opens reject symlinks too. Each running call holds an export lease.

At boot, before calls, and hourly, GC deletes exports unused for 24 hours, but never an active lease. It also removes old interrupted export/mirror staging directories. Orphan containers are found by the fixed label and removed only when not owned by a live call. The cache checks its combined mirror/export/staging usage against 50 GB (50000000000 bytes) before admission and after growth. This is an application watermark, not a filesystem quota: a single Git transfer can cross it before the next check. Provisioned host storage remains a rollout concern.

`workspace_receipt` structured logs go to the service journal. They contain repo, SHA, export digest, container name, observed tool-call count, wall time, collected exit code (null if interrupted before collection), actual peon model, requested/applied thinking and the output-token ceiling. They contain neither prompts, file contents, remote URLs nor keys. Accounting sums all assistant turns, including tool-use turns, before the shared final-answer decoder emits Responses events.

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

This migration changes only the model token in Servo's reviewed argv, from `peon/claude-opus-5-5` to `peon/gpt-6.1-sol`. Sandbox flags, tools and system prompt stay unchanged. The model now supports xhigh/max rather than clamping them to high.

The gateway contract is exercised through the real `gatewayThinkerOptions` workspace path in `test/gateway-contract.test.ts`, for every planner thinking level. At `off`, the worker sends effort `none`; omitted reasoning also defaults to `none`. Both become Pi `--thinking low`, Sol's minimum wire effort. The planner's `minimal` level arrives as effort `minimal` and also becomes `low`. The worker's existing Sol metadata clamps xhigh/max to high before sending; direct bridge requests can use xhigh/max because the image declares them. Unknown fields remain errors, and the ordinary Opus bridge request schema is unchanged.

V1 requires exactly the five shell tools in the request. A subset or duplicate set is refused rather than silently granting more tools. The bridge accepts `max_output_tokens` from 16 through 128000, including the worker's current Sol ceiling of 32000. Pi 0.86.1's CLI has no per-call output-token flag, so the peon still runs at the baked model ceiling of 128000, potentially context-clamped by Pi. Receipts record both `requestedOutputTokens` and `outputTokenCap`; this is not enforcement of the caller's smaller cap. Changing ordinary Sol gateway metadata is outside this packet.

The system prompt, tool list, cwd and agent-directory paths are fixed across leaves. The first admitted leaf becomes the cache leader once per bridge process start; there is no re-election. Followers wait for its first successful assistant `message_end` on stdout, which follows the first model response, or for that leaf's cleanup if it fails. Split stdout chunks are supported. No timer guesses cache readiness.

The gateway resolves planner alias `sol` to model ID `gpt-6.1-sol` before building the workspace request. The bridge accepts those two explicit aliases and records `peon/gpt-6.1-sol`; other models fail before export or Docker work. Claude requests name the extra-usage block. Provider errors retain their observed HTTP status and a credential-redacted diagnostic capped at 512 characters; a provider 4xx is not labelled a model refusal.

Pi is not patched. Its Responses provider sends `store: false`, full transcript input, native function tools, a prompt cache key and session affinity headers. A real provider cache hit still needs rollout proof.

## Provider feature boundary

The source audit reads `dist/api/openai-responses.js` and `openai-responses-shared.js` from pi-ai inside the digest-pinned Pi 0.86.1 base image. `createClient` uses OpenAI's SDK with `baseURL: model.baseUrl`; `client.responses.create` appends `/responses`, so the baked base URL ends in `/v1`. `buildParams` sends model, input, stream, store, optional max_output_tokens, temperature, service_tier, prompt_cache_key, prompt_cache_retention, reasoning, include, tool_choice and tools. Neither previous_response_id nor background is needed. Explicit prompt-cache mode and additional/tool-search/grammar compat features are not enabled in this image and are not admitted by the proxy.

Headers are closed to HTTP transport headers, bearer, Node fetch transport metadata (`accept-language`, `sec-fetch-mode`), Pi User-Agent, `session_id`, `x-client-request-id`, and the OpenAI SDK's `x-stainless-{lang,package-version,os,arch,runtime,runtime-version,retry-count,timeout}` metadata. Feature headers, including OpenAI and Anthropic betas, are refused before upstream access. The proxy does not forward client transport routing or credentials.

`test/responses-provider.test.ts` drives the repository's real vendored pi-ai provider through the HTTP proxy and fake upstream for every applied thinking level, using the baked model configuration. The repository provider is 1.3.1-main.73f8de8, not the image's 0.86.1. Both use the same path, default headers and body fields for this configuration; the newer provider adds configuration-update handling outside this path. The image's real outgoing-request capture remains a rollout cross-check, not a claim made by the repository test.

## Image and rollout

Build context is this directory. `PI_IMAGE` must be an existing Pi image **pinned by SHA-256 digest**, with Node, Pi, bash, rg, fd and find already installed. The single build-time check also requires sh, env, mkdir, cp, chmod and which on the same fixed PATH the cell uses; it installs nothing. The Dockerfile installs no packages and rejects an unpinned base. Review the base's Pi version against the runtime protocol before approving it.

The entrypoint copies only baked model/settings files to `/tmp/peon`, then executes Pi under `env -i`. HOME and the agent directory are `/tmp/peon`; no host HOME or provider secret is inherited. Only the private tmpfs copies of models/settings are changed to mode 0600, so Pi can update settings; the baked `/opt/peon` assets remain 0444. The baked model uses `openai-responses`, provider `peon`, model `gpt-6.1-sol`, and the literal placeholder `proxy`; its 500000-token context and 128000 output maximum match the fleet Sol entry. The explicit thinking map enables xhigh/max and disables off; pinned Pi clamps an off request to minimal, whose wire effort is low. Grammar/additional/tool-search compat switches are deliberately not copied from the fleet entry. The host proxy replaces that placeholder. Both root and `/work` remain read-only. Writable configuration and scratch disappear with the tmpfs.

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

The image test executes the real entrypoint with only its absolute filesystem roots relocated into a disposable fixture. It verifies that baked 0444 assets become private writable 0600 copies, HOME points at the private copy directory, an incoming key is discarded, and Docker mounts only the readonly checkout and `/tmp` tmpfs. It does not run Docker or Pi from the real image.

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
