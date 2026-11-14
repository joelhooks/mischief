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

The bridge image must contain `/opt/claude-bridge`, its installed dependencies, a 40-hex `COMMIT` file, and `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`. The build checks both image digests, `pi --version`, the bridge commit file and `claude --version`. There are no BuildKit-only mounts or external `COPY --from` references.

`models.json` and `settings.json` are the image's defaults. The manager copies them into a new box's agent directory through its isolated preparation container. Clone and restore retain the existing settings and session. The model's zero cost entries are placeholders, not a price claim; actual token counts come from Pi events.

This packet does not prove an image build or a live turn. The desk owns those checks.

## Opt-in host units

Both unit declarations are absent unless `MISCHIEF_PEON_BOXES=on`. Both entries also exit without listening when the flag is off.

Set these values for the infra process:

- `MISCHIEF_PEON_BOXES=on`
- `MISCHIEF_BOX_ENTRY=<absolute built apps/workspace-bridge/dist/box-main.js>`
- `MISCHIEF_PEON_FULL_PROXY_ENTRY=<absolute built apps/workspace-bridge/dist/full-proxy-main.js>`

The generated user units are `mischief-peon-boxes.service` and `mischief-peon-full-proxy.service`. Their private environment files are separate:

### `peon-boxes.env`

```dotenv
MISCHIEF_PEON_BOXES=on
MISCHIEF_BOX_KEY=<shared worker/manager bearer>
MISCHIEF_PEON_BOX_IMAGE=<built full image>@sha256:<digest>
MISCHIEF_BOX_MIRRORS={"owner/repo":"<absolute existing local walgit mirror>"}
MISCHIEF_BOX_ROOT=/srv/mischief/peon-boxes
MISCHIEF_BOX_SNAPSHOTS=/srv/mischief/peon-snapshots
MISCHIEF_BOX_METADATA=/srv/mischief/peon-metadata
```

The three storage paths must be absolute, disjoint host-owned directories and are required when starting the manager. Overlapping roots are refused because deleting one peon could erase request receipts or another peon's snapshots. They have no defaults; startup names every missing path before a box can write into an unintended directory. The paths above are neutral examples. Supply the approved host paths in its private environment file.

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

The long-lived container is `mischief-peon-box-<peonId>`. It runs `sleep infinity`, uid 65534, the template's CPU/memory/PID limits, `--cap-drop ALL`, `no-new-privileges`, and `--restart no`. Its writable root filesystem is disposable. Only `/work` and `/home/peon` are mounted from the host.

The container uses `mischief-peon-boxes`, `mischief-peon-boxes.slice`, and explicit DNS servers `1.1.1.1` and `9.9.9.9`. Docker's default resolver forwards to the LAN router and leaks LAN names; the explicit DNS arguments avoid that path. The host network rule and slice must already exist. This packet does not create or change them.

A short preparation container runs from the same pinned image, with no network, a read-only root, only the CHOWN capability, and only that peon's directory mounted. It assigns uid 65534 and the manager's gid, and grants group access. Without it the peon cannot write the checkout; without the manager gid the manager cannot snapshot or delete the files. The helper runs again before copying, snapshotting or deleting a box because full tools can create restrictive modes.

Host-only metadata is authoritative for lifecycle state and request receipts. It is never mounted into a box. The session and writable workspace live under `<box root>/<peonId>/{home,work}`. Successful prompt results are also mirrored under `home/.box/requests/<sha256(requestId)>.json`; that mirror is not trusted for idempotency.

Each mutating call accepts any nonempty request id up to 512 characters. Receipt filenames use its SHA-256 hex digest; the raw id stays inside the receipt and must match on replay. Slashes, colons and `..` never become host paths. The first committed result or typed error is returned for a repeated id, even after manager reconstruction. An in-flight receipt without an outcome returns 409 instead of repeating unknown tool effects. Inspect and reconcile that host receipt before submitting a new id. This is an explicit uncertainty state, not an exactly-once claim across a host crash.

Suspend stops the container and checks Docker reports `Running=false` and `Pid=0`. Inspect reports zero processes for a stopped box; for a running box it counts Docker's process table. Prompt implicitly resumes suspended or hibernated boxes. Its `resumeMs` measures start-to-ready time, while `wallMs` includes that wake and the turn.

Hibernate stops the container, prepares readable files, archives `work` and `home`, measures bytes and SHA-256, records the snapshot, then removes the container and mounted directories. Restore checks that SHA before unpacking. Clone accepts idle, suspended or hibernated sources and leaves a new stopped container with the session bytes unchanged. Delete retains host metadata, request receipts and snapshots. A destroyed id is a tombstone; use a new peon id rather than overwriting it.

Rollback: disable the flag in infra and both environment files, stop the two units through the desk's deploy flow, and leave box directories and snapshots intact. Turning off the manager does not stop existing containers. Suspend them first when zero processes is required.

## Verification

The local tests execute a fake `docker` binary on PATH, but real local Git, tar, copy, disk measurement and SHA tools. They cover lifecycle and snapshot round trips, clone from each allowed state, zero-process suspension, implied wake, idempotency across reconstruction, untrusted home receipts, concurrent prompt/clone conflicts, HTTP authentication and decoding, key replacement, unrestricted beta/tool pass-through, streaming admission and bounded errors.

The desk still needs to measure real wake latency, idle memory, workspace/snapshot bytes and prompt-cache reads after resume and clone. The fake Docker test cannot establish those measurements or validate host UID/cgroup/network behavior.
