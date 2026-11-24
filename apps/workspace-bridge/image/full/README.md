# Full peon boxes

This image runs a persistent, writable peon workspace. The existing read-only workspace image and proxy are unchanged.

## Build contract

Build from the repository root. Supply immutable Node and bridge image references and an exact Pi version:

```sh
DOCKER_BUILDKIT=0 docker build \
  --file apps/workspace-bridge/image/full/Dockerfile \
  --build-arg NODE_IMAGE='<node image>@sha256:<digest>' \
  --build-arg CLAUDE_BRIDGE_IMAGE='<bridge image>@sha256:<digest>' \
  --build-arg PI_VERSION='0.86.1' \
  --tag mischief-peon-full:review .
```

The bridge image must contain `/opt/claude-bridge`, its installed dependencies, a 40-hex `COMMIT` file, and an executable native Claude Code binary at `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` on x86_64 or `node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude` on aarch64/arm64. The build selects the package with `uname -m`, refuses a missing binary with its path, and links it as `/usr/local/bin/claude`. The build checks both image digests, `pi --version`, the bridge commit file and `claude --version`. There are no BuildKit-only mounts or external `COPY --from` references.

`models.json` and `settings.json` are the image's defaults. The manager copies them into a new box's agent directory through its isolated preparation container. Clone and restore retain the existing settings and session. The model's zero cost entries are placeholders, not a price claim; actual token counts come from Pi events.

This packet does not prove an image build or a live turn. The desk owns those checks.

## Opt-in host units

Both unit declarations are absent unless `MISCHIEF_PEON_BOXES=on`. Both entries also exit without listening when the flag is off.

Set these values for the infra process:

- `MISCHIEF_PEON_BOXES=on`
- `MISCHIEF_BOX_ENTRY=<absolute built apps/workspace-bridge/dist/box-main.js>`
- `MISCHIEF_BOX_MOUNT=<absolute dedicated capped volume mountpoint>` (required; no default)
- `MISCHIEF_PEON_FULL_PROXY_ENTRY=<absolute built apps/workspace-bridge/dist/full-proxy-main.js>`

The generated user units are `mischief-peon-boxes.service` and `mischief-peon-full-proxy.service`. Their private environment files are separate:

### `peon-boxes.env`

```dotenv
MISCHIEF_PEON_BOXES=on
MISCHIEF_BOX_KEY=<shared worker/manager bearer>
MISCHIEF_PEON_BOX_IMAGE=<built full image>@sha256:<digest>
MISCHIEF_BOX_MIRRORS={"owner/repo":"<absolute existing local walgit mirror>"}
MISCHIEF_BOX_MOUNT=/srv/peon-volume
MISCHIEF_BOX_ROOT=/srv/peon-volume/boxes
MISCHIEF_BOX_SNAPSHOTS=/srv/peon-volume/snapshots
MISCHIEF_BOX_METADATA=/srv/peon-volume/metadata
```

The box manager unit has `ConditionPathIsMountPoint` set from `MISCHIEF_BOX_MOUNT`, so it does not start when the capped volume is absent. Supply the same mountpoint to infra and the manager. The mountpoint must be a canonical absolute dedicated path, not `/`; infra accepts path components made of letters, digits, dots, underscores and hyphens, starting with a letter, digit, underscore or hyphen, with no trailing slash. All bridge, proxy and box units accept exit status 130 as a clean stop.

The three storage paths must be absolute, disjoint host-owned directories beneath that mountpoint and are required when starting the manager. Startup refuses paths outside the volume or through symlinks before creating storage directories: escaping the cap could fill the shared disk and stop other services. Overlapping roots are refused because deleting one peon could erase request receipts or another peon's snapshots. They have no defaults; startup names every missing path before a box can write into an unintended directory. The paths above are neutral examples. Supply the approved host paths in its private environment file.

The manager listens on `127.0.0.1:28014`. Worker bindings need the same nonempty `MISCHIEF_BOX_KEY` and a reachable `MISCHIEF_BOX_URL`. The sibling worker packet owns those bindings and their caller grants.

### `peon-full-proxy.env`

```dotenv
MISCHIEF_PEON_BOXES=on
MISCHIEF_PEON_CLIPROXY_URL=<credential-free provider base URL, without /v1>
MISCHIEF_PEON_CLIPROXY_KEY=<host-only provider key>
MISCHIEF_PEON_FULL_MODELS=["gpt-6.1-sol","claude-opus-5-5"]
MISCHIEF_BOX_KEY=<shared host manager bearer>
```

The full proxy listens only on `172.30.212.1:28013`. It forwards POST `/v1/responses` and `/v1/messages`, with optional `?beta=true`. It replaces both credential headers, passes through request fields, feature headers and tools, holds at most eight streams, and reads at most 64 KiB of an upstream error. Metered boxes cannot start deferred Responses work (`background: true`) because the proxy would not see its usage. Returned errors omit the upstream body so a provider cannot echo the host key.

Upstream transport failures and HTTP 5xx responses emit one `peon_upstream_transport_error` JSON line on stderr. The line contains the model, route without its query, elapsed milliseconds, status or error class, and the proxy-generated ID sent upstream as `x-mischief-request-id`. It excludes headers, bodies, keys and raw exception text. A 503 from the proxy's own stream limit is not an upstream failure.

No host provider key enters a box. The only model credentials written into a box are the placeholder `proxy` values.

### Per-box model spend

The full and restricted model routes trust the TCP socket peer, not forwarding headers or a peon-supplied ID. Managed boxes run with all Linux capabilities dropped, including `NET_RAW` and `NET_ADMIN`, so they cannot spoof another box’s source IP. The manager seeds its owner cache from Docker inventory at startup and invalidates it before changing container membership. Only the manager may attach or start managed boxes on `mischief-peon-boxes`. An operator with Docker access can bypass that lifecycle; leave the network untouched while the manager is serving, or stop the manager before manual repair and restart it to rebuild the cache. Missing or ambiguous identities fail closed. The separate restricted workspace subnet still supports short-lived workspace jobs without a box ledger. Keep routing and the host firewall configured so box traffic cannot appear to come from that subnet.

The manager owns `model-spend.sqlite` in `MISCHIEF_BOX_METADATA`; never mount, clear, or recreate that database on a routine restart. Browser boxes default to 20 upstream attempts per rolling minute and 2,000,000 accounted tokens per UTC day, separately for each peon. `MISCHIEF_BOX_SPEND_LIMITS={"browser":{"ratePerMin":20,"dailyTokens":2000000}}` overrides the browser thresholds. Add a `full` entry with both fields to cap that template too. The daily cap resets at 00:00 UTC (4 PM PST or 5 PM PDT the previous local day). Requests that span midnight stay on their admission day. The rolling request window does not reset at midnight.

Manager restarts can delay admission for any managed box, including uncapped full boxes. Both proxies retry transient admission failures within a 15-second total window, then return HTTP 503 without forwarding. The same admission ID prevents a retried request from debiting twice if the first reply was lost. Neither proxy retries `SpendCap` or retries a provider call already in flight.

After validating the request, the proxy reserves estimated input tokens plus the requested `max_tokens` or `max_output_tokens`. When omitted, the proxy sends and reserves `defaultOutputTokens` (32,000 unless overridden in the template limits). Admission refuses a reservation that would exceed the daily cap. During a response, the proxy records observed bytes and usage frames before forwarding. It settles to the provider’s reported usage, including cache tokens, and releases unused reservations. Where usage is missing, it estimates one token per four bytes. Interrupted requests keep their outstanding reservation for the day; a restart does not release it.

The proxy stops an active response once observed charges plus outstanding reservations exceed the daily cap by more than 10%. This is a proxy cutoff, not a guarantee of exact provider billing: a provider may report work after incurring it. Before HTTP headers, denial is HTTP 429 with `error.code=SpendCap`. Once an SSE response has started, the proxy sends a terminal provider-format error with the same code instead of attempting to change the HTTP status. Pi reports either through `PromptFailed`, which parks the box and clears the pending prompt. Retry with a fresh request ID after the applicable window resets.

At 80%, the manager writes one pending outbox entry per peon, threshold and UTC day in the same transaction as the spend update. The drainer emits `peon_spend_alarm`, sends to `peons/desk`, and marks the entry sent only after Rat King accepts it. It retries unsent entries after a failed send or manager restart. A crash after Rat King accepts but before SQLite records the receipt can produce a duplicate notice. Set `MISCHIEF_BOX_SPEND_MAIL_AS` to a dedicated sender whose key is installed on the manager host, and set `MISCHIEF_BOX_SPEND_MAIL_BIN` to the absolute `ratking` executable if it is not on the service PATH. Verify the identity with `ratking whoami --as <sender>`. Inspect `peon_spend_mail_failed` for delivery trouble. Neither signal contains credentials, request bodies or headers.

Deploy the manager and both proxies together before admitting browser boxes. Give the restricted proxy the same `MISCHIEF_BOX_KEY` and set `MISCHIEF_PEON_BOXES=on` there when enabling the pair. To verify the path, use a temporary low canary limit and a managed browser box on the actual Docker network. Confirm both proxy listeners account for the same peon, a spoofed forwarding header does not change the charge, and the next prompt parks with `SpendCap` after a restart. Verify one alarm in manager logs and in `peons/desk`, then restore the intended limits. To roll back, stop browser admission first; do not run browser boxes against a proxy that predates the cap.

## Container and storage contract

The long-lived container is `mischief-peon-box-<peonId>`. It runs `sleep infinity`, uid 65534, the template's CPU/memory/PID limits, `--cap-drop ALL`, `no-new-privileges`, and `--restart no`. Its root filesystem is `--read-only`. Only `/work` and `/home/peon` are writable bind mounts from the capped host volume. Temporary files use `--tmpfs /tmp:rw,nosuid,nodev,size=<limits.tmp>` and `TMPDIR=/tmp`; `limits.tmp` defaults to `1g` and accepts positive integer Docker size units `b`, `k`, `m`, `g`. This is a memory-backed size ceiling, not persistent storage. There is no writable `/var/tmp`.

The manager sends cache, config and state writes beneath `/home/peon`: `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `npm_config_cache`, `npm_config_prefix`, `PNPM_HOME`, `npm_config_store_dir`, `PIP_CACHE_DIR`, `PYTHONUSERBASE`, `COREPACK_HOME`, `CLAUDE_CONFIG_DIR` and `PI_CODING_AGENT_DIR`. Claude auto-update is disabled. Tools cannot install into the image's global directories; use the home prefix or the workspace.

At container creation, the manager sets `GIT_AUTHOR_*` and `GIT_COMMITTER_*` to `shitratgit[bot] <286405550+shitratgit[bot]@users.noreply.github.com>`. This applies to new boxes, clones, and hibernated boxes when they resume into a newly created container. Restarting the manager does not change an existing container's environment. The box gets no signing key; the desk still publishes.

The container uses `mischief-peon-boxes`, `mischief-peon-boxes.slice`, and explicit DNS servers `1.1.1.1` and `9.9.9.9`. Docker's default resolver forwards to the LAN router and leaks LAN names; the explicit DNS arguments avoid that path. The host network rule and slice must already exist. This packet does not create or change them.

A short preparation container runs from the same pinned image, with no network, a read-only root, only the CHOWN capability, and only that peon's directory mounted. It assigns uid 65534 and the manager's gid, and grants group access. Without it the peon cannot write the checkout; without the manager gid the manager cannot snapshot or delete the files. The helper runs again before copying, snapshotting or deleting a box because full tools can create restrictive modes.

Host-only metadata is authoritative for lifecycle state and request receipts. It is never mounted into a box. The session and writable workspace live under `<box root>/<peonId>/{home,work}`. Successful prompt results are also mirrored under `home/.box/requests/<sha256(requestId)>.json`; that mirror is not trusted for idempotency.

Each mutating call accepts any nonempty request id up to 512 characters. Receipt filenames use its SHA-256 hex digest; the raw id stays inside the receipt and must match on replay. Slashes, colons and `..` never become host paths. The first committed result or typed error is returned for a repeated id, even after manager reconstruction. An in-flight receipt without an outcome returns 409 instead of repeating unknown tool effects. Inspect and reconcile that host receipt before submitting a new id. This is an explicit uncertainty state, not an exactly-once claim across a host crash.

Suspend stops the container and checks Docker reports `Running=false` and `Pid=0`. Inspect reports zero processes for a stopped box; for a running box it counts Docker's process table. Prompt implicitly resumes suspended or hibernated boxes. Its `resumeMs` measures start-to-ready time, while `wallMs` includes that wake and the turn.

Hibernate stops the container, prepares readable files, archives `work` and `home`, measures bytes and SHA-256, records the snapshot, then removes the container and mounted directories. Restore checks that SHA before unpacking. Clone accepts idle, suspended or hibernated sources and leaves a new stopped container with the session bytes unchanged. Delete retains host metadata, request receipts and snapshots. A destroyed id is a tombstone; use a new peon id rather than overwriting it.

Rollback: disable the flag in infra and both environment files, stop the two units through the desk's deploy flow, and leave box directories and snapshots intact. Turning off the manager does not stop existing containers. Suspend them first when zero processes is required.

## Verification

The local tests execute a fake `docker` binary on PATH, but real local Git, tar, copy, disk measurement and SHA tools. They cover lifecycle and snapshot round trips, clone from each allowed state, zero-process suspension, implied wake, idempotency across reconstruction, untrusted home receipts, concurrent prompt/clone conflicts, HTTP authentication and decoding, key replacement, unrestricted beta/tool pass-through, streaming admission and bounded errors.

### Desk-only read-only root and prompt proof

Run this against a newly created running review box after rebuilding and deploying through the approved desk flow. Do not use an existing container created before this change: resume does not retrofit its Docker flags. Export `PEON_ID`, the manager's `MISCHIEF_BOX_KEY` and `MISCHIEF_BOX_URL` privately first. The check creates and removes only unique probe files, proves `/etc` is unwritable, then sends a real prompt through the manager. It fails on an HTTP error, nonzero turn exit or missing output. Save the output as live evidence; fake Docker does not prove this behavior.

```sh
box="mischief-peon-box-${PEON_ID:?set a running review box id}"
test "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$box")" = true &&
docker exec "$box" /bin/sh -eu -c '
  tmp=$(mktemp /tmp/readonly-proof.XXXXXX)
  work=$(mktemp /work/readonly-proof.XXXXXX)
  home=$(mktemp /home/peon/readonly-proof.XXXXXX)
  denied="/etc/${tmp##*/}"
  trap '\''rm -f "$tmp" "$work" "$home"'\'' EXIT
  if touch "$denied"; then
    rm -f "$denied"
    printf "FAIL: root filesystem accepted a write\\n" >&2
    exit 1
  fi
  printf "PASS: tmp, work and home writable; etc denied\\n"
' &&
node --input-type=module <<'JS'
const { PEON_ID, MISCHIEF_BOX_URL, MISCHIEF_BOX_KEY } = process.env;
if (!PEON_ID || !MISCHIEF_BOX_URL || !MISCHIEF_BOX_KEY) throw new Error("Set PEON_ID, MISCHIEF_BOX_URL and MISCHIEF_BOX_KEY privately first");
const response = await fetch(`${MISCHIEF_BOX_URL.replace(/\/$/, "")}/v1/boxes/${PEON_ID}/prompt`, {
  method: "POST",
  headers: { authorization: `Bearer ${MISCHIEF_BOX_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ requestId: `readonly-proof-${crypto.randomUUID()}`, text: "Run a shell command that creates and removes a unique file in each of /tmp, /work and /home/peon, confirms a unique file cannot be created in /etc, and runs git --version, node --version, npm --version, python3 --version and claude --version. If pnpm is installed, also run pnpm --version. Report the results and any failure." }),
});
if (!response.ok) throw new Error(`Prompt failed with HTTP ${response.status}`);
const result = await response.json();
if (result.exit !== 0 || !result.output || !result.toolCalls?.length) throw new Error("Read-only prompt did not complete a tool call; inspect the review box");
console.log(JSON.stringify(result, null, 2));
JS
```

Inspect the prompt output: every tool version and write probe must succeed as specified before calling the image verified. A completed turn alone does not prove the agent followed every instruction.

The desk still needs to measure real wake latency, idle memory, workspace/snapshot bytes and prompt-cache reads after resume and clone. The fake Docker test cannot establish those measurements or validate host UID/cgroup/network behavior.
