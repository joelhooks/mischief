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
```

The full proxy listens only on `172.30.212.1:28013`. It forwards POST `/v1/responses` and `/v1/messages`, with optional `?beta=true`. It replaces both credential headers, passes through request fields, feature headers and tools, holds at most eight streams, and reads at most 64 KiB of an upstream error. Returned errors omit the upstream body so a provider cannot echo the host key.

No host provider key enters a box. The only model credentials written into a box are the placeholder `proxy` values.

## Container and storage contract

The long-lived container is `mischief-peon-box-<peonId>`. It runs `sleep infinity`, uid 65534, the template's CPU/memory/PID limits, `--cap-drop ALL`, `no-new-privileges`, and `--restart no`. Its root filesystem is `--read-only`. Only `/work` and `/home/peon` are writable bind mounts from the capped host volume. Temporary files use `--tmpfs /tmp:rw,nosuid,nodev,size=<limits.tmp>` and `TMPDIR=/tmp`; `limits.tmp` defaults to `1g` and accepts positive integer Docker size units `b`, `k`, `m`, `g`. This is a memory-backed size ceiling, not persistent storage. There is no writable `/var/tmp`.

The manager sends cache, config and state writes beneath `/home/peon`: `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `npm_config_cache`, `npm_config_prefix`, `PNPM_HOME`, `npm_config_store_dir`, `PIP_CACHE_DIR`, `PYTHONUSERBASE`, `COREPACK_HOME`, `CLAUDE_CONFIG_DIR` and `PI_CODING_AGENT_DIR`. Claude auto-update is disabled. Tools cannot install into the image's global directories; use the home prefix or the workspace.

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
