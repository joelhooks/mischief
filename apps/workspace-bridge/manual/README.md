# Real Docker lifecycle check

## Failure and repair

Agent-created mode-700 directories belong to uid 65534. The manager's gid and the CHOWN-only helper cannot traverse them. The manager first grants group access on entries it owns. A CHOWN-only root helper then hands root-owned and manager-owned entries to uid 65534, recovering both old manager-owned trees and partial ownership left by the old failed helper. Both passes tolerate only find's unreadable-subtree diagnostics, not chmod or chown failures or other errors. The owner-only chmod helper then grants traversal before host copies, archives, deletion, and size measurements. Restoring an archive creates a fresh manager-owned tree, so host permission preparation runs before ownership transfers to uid 65534.

The worker used to resume a sleeping box before calling its prompt endpoint. That made the prompt endpoint see an idle box and report zero resume time. The prompt endpoint now owns the wake and its timing. Every stop checks Docker's running flag and PID before saving a sleeping state.

Lifecycle reports used to keep their initial null byte count. The worker now reads manager measurements after each lifecycle operation and stores them with the completed report. Process counts remain optional for old stored reports and older box-manager responses; the current manager supplies measured counts.

## Run the check

This opt-in Vitest check is skipped unless `MISCHIEF_REAL_DOCKER_SCRATCH` is set. It imports source directly, so lint does not depend on generated workspace-bridge output. It uses live Effect services so Docker wake timings use the real clock, not TestClock. It runs the real box manager against Docker, with a fake Pi that writes mode-700 directories as uid 65534. It never calls a model. The fake cache-read counter proves that the copied session is present, not that a provider accepted a cache entry.

From the checkout root, with workspace dependencies installed:

```sh
bash -eu <<'SH'
pnpm turbo run build --filter='@mischief/workspace-bridge^...'
root=$(mktemp -d "$(pwd -P)/.mpt-XXXXXXXX")
trap 'rmdir -- "$root"' EXIT
export TMPDIR="$root"
export NODE_DISABLE_COMPILE_CACHE=1
export MISCHIEF_REAL_DOCKER_SCRATCH="$root/.mpt-run"
export MISCHIEF_REAL_DOCKER_IMAGE=mischief-peon-full:ab95d63
export MISCHIEF_REAL_DOCKER_PREFIX="mpt-$(basename "$root" | tr '[:upper:]' '[:lower:]' | cut -c 6-)-"
pnpm --filter @mischief/workspace-bridge exec vitest run test/box-lifecycle.docker.test.ts
SH
```

The test timeout is six minutes. Use a checkout on local storage. The command creates a fresh scratch parent and prefix for each run. The image `mischief-peon-full:ab95d63` must already be present on the local daemon; the test does not pull or build an image. It prints the immutable `sha256:` image ID before creating any containers and uses that ID and `--pull never` throughout. It labels every container `sh.mischief.lifecycle-test=<prefix>`. It translates manager container names to that prefix, disables networking, omits the production cgroup, and replaces Pi execution with the fake executable. Ownership and Git proof helpers keep their production users, capabilities, mounts, and commands.

The check covers spawn, owner-only writes, idle and suspended clones, stopped-state inspection, prompt wake timing, snapshot, hibernate, restore, byte measurements, and deletion. It deliberately runs the old helper until it fails and asserts partial root ownership before proving clone, snapshot, and deletion recover. It also plants all-manager-owned mode-700 trees and repeats clone, snapshot, and deletion. After recovery, a capability-free root:gid container walks the full tree and requires that no root-owned or manager-owned entry remains. The manager's chmod pass excludes symlinks so it cannot change a target outside the box.

The destroy check uses real Git in the proof container and real filesystem custody tools on two local scratch directories. It verifies clean live and hibernated `landedHead`, refuses untracked bytes, an `assume-unchanged` edit, an unmerged branch, a stash, and a stash reflog FIFO (15-second bound). It checks `ReplicaPending`, copies the primary archive with `rsync -a`, and checks `ReplicaMismatch` on a one-byte replica edit. After resume it checks that a deleted live transcript still exists under `snapshot/` in both copies. The only archive check replaced for this suite is the CIFS mount check; the suite never uses a NAS.

The test prints the failure and its step before cleanup. Cleanup inspects exact container names and removes only those with this run's label. A labeled, network-disabled helper with `DAC_OVERRIDE` clears the run's box tree even if an ownership fault left it unreadable. The test removes its scratch on success and reports any cleanup failure separately.
