# Browser peon image

`browser@1` extends `full@1` with Chromium, agent-browser 0.44.0, D-Bus, fontconfig, Noto and color emoji. It inherits the full peon timeouts. Use only synthetic accounts and test sites. Never put a real identity, cookie, production account, credential or Burrow profile in a browser box. Re-review before introducing any real credential, visiting a non-test site, or turning on a per-template egress fence.

## Build and configure

From the repo root, build on the approved image host using the digest of the built full image:

```sh
docker build --build-arg FULL_IMAGE="${FULL_DIGEST_REFERENCE}" \
  -f apps/workspace-bridge/image/browser/Dockerfile -t mischief-peon-browser:local .
```

After the browser image has a registry digest, set `MISCHIEF_PEON_BOX_IMAGES` to a JSON object with `full` and `browser` keys. Each value is a complete `repository@sha256:<64 lowercase hex>` reference. The legacy `MISCHIEF_PEON_BOX_IMAGE` supplies `full` if the map omits it. Restart the box manager. New boxes select images from the map; wake and clone use the image recorded at creation. Keep old images available for hibernated boxes. Deploy `browser@1` only together with the separate spend-cap change.

Use `spawnPeon` with `template: { "name": "browser", "version": 1 }`, a pinned `overrides.workspace`, and `overrides.browser.hosts`, such as `["qa.example.test", "assets.example.test"]`. These are exact lowercase DNS names; include every test origin the page needs. Empty lists, wildcards, IP literals, URLs, and ports are refused.

The browser gets 4 CPUs for browser plus build work, and 4 GiB RAM as a starting ceiling. Burrow measured about 1 GiB per instance; 4 GiB is not a promise that every build and test matrix fits. The 1024 PID ceiling includes Chrome’s renderer, utility and other process threads as well as the agent and app under test. `--disable-dev-shm-usage` directs Chrome’s shared-memory files to `/tmp`; the 2 GiB tmpfs leaves room for those files, temporary profiles and screenshots without enlarging `/dev/shm`. Tmpfs consumption still competes for the container’s memory budget. The CPU, PID and tmp ceilings are starting values, not measured saturation points.

## Isolation and browser launch

The default Docker seccomp profile stays in place. The browser process runs as UID 65534 with all capabilities dropped, no-new-privileges, and a read-only root. The image’s `peon-browser` launcher applies one named `--no-sandbox` flag only to browser launches. Docker is the sandbox here: a renderer exploit can exercise the same access as the agent inside the container. If Chromium crashes on a blocked syscall, record the syscall and report it; do not loosen seccomp.

Agent-browser uses `peon-browser` as its Chromium executable. The launcher sends other destinations through a refuse-all loopback proxy, bypasses it only for the named test hosts, removes Chromium’s implicit loopback bypass, disables non-proxied WebRTC UDP, and refuses other lookups in its host resolver. These flags are a browser-level stopgap. They do not restrict the agent’s shell, a manually replaced launcher, DNS changes at the test hosts, or any other process. A host-enforced per-template egress fence is the network boundary, not these flags.

## Optional Burrow release

Servo stages an immutable host release at `$MISCHIEF_BOX_BROWSER_BUILDS/<tar-sha256>/`: keep `burrow-linux-x64.tar.gz` beside `unpacked/`, which contains the exact extracted tree. Use a canonical host-owned path outside every box’s writable trees. Publish the complete directory atomically, preserve the archive’s file metadata when extracting, and never mutate a published release. The manager verifies the archive checksum and compares the unpacked inventory and contents before each new bind. Keep the release available for hibernated boxes. The build is the only additional bind mount; Docker mounts just `unpacked/` at `/opt/burrow`, read-only and without submounts.

Set `overrides.browser.burrowSha256` to the exact tarball SHA-256 to request the build. No SHA means no Burrow bind. With the bind present the manager sets `BURROW_CELL_IN_BOX=1` and passes `PEON_BROWSER_HOSTS` to the cell. Magellan’s `burrow-cell` launcher owns start, stop and sweep. It can use `peon-browser --launch-flags` (one argument per line, preserve spaces) for the same flags as agent-browser. Start the pinned build with `dbus-run-session`, `--headless=new --disable-gpu`, and throwaway `HOME`, `XDG_CONFIG_HOME` and `--user-data-dir` under `/tmp`. The image does not bundle `burrow-cell` or any profile.

## Local image proof

On the approved Docker host with the pinned image already present, set `MISCHIEF_REAL_DOCKER_BROWSER_IMAGE` to that digest reference and run:

```sh
pnpm --filter @mischief/workspace-bridge exec vitest run test/browser.docker.test.ts
```

The test does not pull an image or use the network. It prints `SecurityOpt` and `CapAdd`, then checks that Chromium writes a PNG screenshot of a `data:` page. It skips by default.
