# Real Docker lifecycle check

## Failure and repair

Agent-created mode-700 directories belong to uid 65534. The manager's gid and the CHOWN-only helper cannot traverse them. The manager first grants group access on entries it owns. A CHOWN-only root helper then hands root-owned and manager-owned entries to uid 65534, recovering both old manager-owned trees and partial ownership left by the old failed helper. Both passes tolerate only find's unreadable-subtree diagnostics, not chmod or chown failures or other errors. The owner-only chmod helper then grants traversal before host copies, archives, deletion, and size measurements. Restoring an archive creates a fresh manager-owned tree, so host permission preparation runs before ownership transfers to uid 65534.

The worker used to resume a sleeping box before calling its prompt endpoint. That made the prompt endpoint see an idle box and report zero resume time. The prompt endpoint now owns the wake and its timing. Every stop checks Docker's running flag and PID before saving a sleeping state.

Lifecycle reports used to keep their initial null byte count. The worker now reads manager measurements after each lifecycle operation and stores them with the completed report. Process counts remain optional for old stored reports and older box-manager responses; the current manager supplies measured counts.

## Run the check

This opt-in Vitest check is skipped unless `MISCHIEF_REAL_DOCKER_SCRATCH` is set. It imports source directly, so lint does not depend on generated workspace-bridge output. It uses live Effect services so Docker wake timings use the real clock, not TestClock. It runs the real box manager against Docker, with a fake Pi that writes mode-700 directories as uid 65534. It never calls a model. The fake cache-read counter proves that the copied session is present, not that a provider accepted a cache entry.

From the checkout root, with workspace dependencies installed:

```sh
mkdir -p /data/joel/scratch/peonlife
MISCHIEF_REAL_DOCKER_SCRATCH=/data/joel/scratch/peonlife/proof-1 \
MISCHIEF_REAL_DOCKER_IMAGE=mischief-peon-full:ab95d63 \
MISCHIEF_REAL_DOCKER_PREFIX=mpt-peonlife-proof-1- \
pnpm --filter @mischief/workspace-bridge exec vitest run test/box-lifecycle.docker.test.ts
```

The test timeout is three minutes. The scratch path must be absolute, new, and beneath this checkout or `/data/joel/scratch/peonlife/`. Its parent must exist and be canonical. Prefer the scratch mount so failed runs never dirty the checkout. The prefix must start with `mpt-`. Choose a fresh prefix for each concurrent run. The runner resolves the approved local image to its immutable image ID before starting anything. It translates manager container names to the supplied prefix, disables networking, omits the production cgroup, and replaces only Pi execution with the fake executable. Ownership helpers keep their production users, capabilities, mounts, and commands.

The check covers spawn, owner-only writes, idle and suspended clones, stopped-state inspection, prompt wake timing, snapshot, hibernate, restore, byte measurements, and deletion. It deliberately runs the old helper until it fails and asserts partial root ownership before proving clone, snapshot, and deletion recover. It also plants all-manager-owned mode-700 trees and repeats clone, snapshot, and deletion. After recovery, a capability-free root:gid container walks the full tree and requires that no root-owned or manager-owned entry remains. It prints a primary failure with its step and stack before cleanup. Cleanup removes only container names created by the run. One capability-free container as uid 65534 empties the scratch's box directories. The manager removes its remaining scratch entries and leaves the empty root, printing its path. Cleanup failures print warnings and retain the path; they never replace a primary failure. The manager's chmod pass excludes symlinks so it cannot change a target outside the box.
