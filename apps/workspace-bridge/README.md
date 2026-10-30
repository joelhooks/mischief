# Workspace bridge

A read-only checkout adapter for workspace thinks. The bridge accepts the model-bridge Responses contract plus `workspace: { repo, sha }` and `tools`, then returns the same Responses SSE events.

This packet defines code and user units only. Nothing here creates a Docker network, slice, firewall rule or unit, and the units are not registered with the infrastructure stack. No Docker or live provider proof has run.

## Processes

- `dist/main.js`: authenticated Responses bridge on loopback, port 28011.
- `dist/proxy-main.js`: keyless cell-facing Anthropic Messages proxy on the peon network gateway, port 28012.

The proxy uses **Messages**, not the text-only Opus bridge. Pi needs native tool calls; the text-only bridge deliberately rejects them. Only `POST /v1/messages` without a query string reaches the configured provider. The proxy replaces both authentication headers with its host-only key, passes `anthropic-version`, adds `X-Cliproxy-Client: mischief/peons`, and preserves successful stream bytes. It refuses unknown top-level fields, provider-side tools and connectors. Client tools are limited to read, grep, find, ls and bash.

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
| `MISCHIEF_PEON_CLIPROXY_URL` | Dedicated provider base URL, without `/v1/messages` |
| `MISCHIEF_PEON_CLIPROXY_KEY` | Provider key; proxy process only |
| `MISCHIEF_PEON_MODELS` | JSON proxy model allowlist; defaults to `["claude-opus-5-5"]` |

The worker's comma-separated `MISCHIEF_WORKSPACE_REPOS` is separate. A worker/bridge allowlist mismatch fails closed. Mirror URLs must use HTTPS on the configured walgit host, without credentials, query strings or fragments. Read-only Git credentials belong in the host's system Git configuration; the runner does not inherit the operator's environment or HOME. Neither mirrors nor Git configuration enter a cell.

The bridge binds its exclusive loopback listener before constructing the export service or sweeping containers. A second bridge cannot sweep the first bridge's live calls. Run one bridge owner for this cache and Docker label.

## Cache and receipts

The remote Git repository owns source history. The bridge is the only writer of the derived mirror, SHA-addressed export and last-use metadata. Removing the dedicated cache and fetching the approved commit rebuilds these copies. Callers never choose a remote URL or host path.

Preparation is serialized. A mirror fetch verifies `<sha>^{commit}` even for a cached export. A new export comes from `git archive`, with a SHA-256 digest of that archive. Git symlinks and submodules are refused before extraction. Every exported path is checked for symlink traversal; files become world-readable and read-only, directories traversable and read-only. Metadata opens reject symlinks too. Each running call holds an export lease.

At boot, before calls, and hourly, GC deletes exports unused for 24 hours, but never an active lease. It also removes old interrupted export/mirror staging directories. Orphan containers are found by the fixed label and removed only when not owned by a live call. The cache checks its combined mirror/export/staging usage against 50 GB (50000000000 bytes) before admission and after growth. This is an application watermark, not a filesystem quota: a single Git transfer can cross it before the next check. Provisioned host storage remains a rollout concern.

`workspace_receipt` structured logs go to the service journal. They contain repo, SHA, export digest, container name, observed tool-call count, wall time, collected exit code (null if interrupted before collection), requested/applied thinking and the output-token ceiling. They contain neither prompts, file contents, remote URLs nor keys. Accounting sums all assistant turns, including tool-use turns, before the shared final-answer decoder emits Responses events.

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
| `--thinking` | Closed Responses enum mapped to supported Pi levels; xhigh/max clamp to high for this custom model, matching the SDK default; requested and applied levels are recorded |

The gateway contract is exercised through the real `gatewayThinkerOptions` workspace path in `test/gateway-contract.test.ts`, for every planner thinking level. At `off`, Pi omits `reasoning`; the workspace decoder normalizes that omission to effort `none`, which becomes Pi `--thinking off`. The planner's `minimal` level arrives as effort `low`. Unknown fields remain errors, and the ordinary Opus bridge request schema is unchanged.

V1 requires exactly the five shell tools in the request. A subset or duplicate set is refused rather than silently granting more tools. The image caps each provider response at 128000 output tokens. Requests specifying a smaller `max_output_tokens` receive a 4xx naming that cap. Normal workspace routing inherits the Opus model's 128000 maximum; context-clamped callers can legitimately hit this refusal.

The system prompt, tool list, cwd and agent-directory paths are fixed across leaves. The first admitted leaf becomes the cache leader once per bridge process start; there is no re-election. Followers wait for its first successful assistant `message_end` on stdout, which follows the first model response, or for that leaf's cleanup if it fails. Split stdout chunks are supported. No timer guesses cache readiness.

Source inspection of the pinned pi-ai provider confirms that `anthropic-messages` attaches `cache_control` to the system text and the last tool by default. Pi is not patched. The chosen base image and real provider cache hit still need rollout proof.

## Provider feature boundary

The proxy accepts only the six feature betas generated on Pi's API-key path: `fine-grained-tool-streaming-2025-05-14`, `interleaved-thinking-2025-05-14`, `server-side-fallback-2026-07-01`, `mid-conversation-output-config-2026-07-01`, `thinking-binding-controls-2026-08-01` and `inline-tools-2026-09-15`. The source is the pinned `@earendil-works/pi-ai/dist/api/anthropic-messages.js`: the six constants and `getBetaFeatures`. Its OAuth-only `claude-code-20250219` and `oauth-2025-04-20` values are refused. The image uses the literal API key `proxy`, not OAuth; a test runs that image configuration through the real Pi provider with a fake fetch boundary to verify the outgoing beta values.

Unknown or malformed header values receive a 4xx before upstream access. The proxy omits `anthropic-beta` when no values are requested. A body `betas` field is not accepted, even for otherwise permitted feature names. Arbitrary beta overrides from model or caller headers do not expand the proxy allowlist.

## Image and rollout

Build context is this directory. `PI_IMAGE` must be an existing Pi image **pinned by SHA-256 digest**, with Node, Pi, bash, rg and find already installed. The Dockerfile installs no packages and rejects an unpinned base. Review the base's Pi version against the runtime protocol before approving it.

The entrypoint copies only baked model/settings files to `/tmp/peon`, then executes Pi under `env -i`. There is no HOME or provider secret. The baked model uses `anthropic-messages`, provider `peon`, and the literal placeholder `proxy`; the host proxy replaces that placeholder. Both root and `/work` remain read-only. Writable configuration and scratch disappear with the tmpfs.

Before go-live, obtain Servo's argv/image review, create the separately owned slice/network/firewall prerequisites, provision read-only mirror access and the dedicated provider key, build and record the resulting workspace image digest, and run one pinned public-repo leaf before a real batch. Prove cancellation, deadline removal, a restart orphan sweep, network isolation and a warm-cache follower. None of those live actions is authorized by this code packet.

Keep workspace routing off until those proofs pass. Rollback is to keep or turn routing off, stop the two user services through the owning deploy workflow, and sweep only labeled peon containers. Mirrors and exports contain no authoritative state.
