# Peon box history custody

Export a full-tools box before deleting it. Export stops an idle box and leaves it suspended. It refuses a running box. For a hibernated box it checks the snapshot hash and extracts only the known session roots. It does not start the box or restore the workspace to export history. After resume, it also archives the prior snapshot's session roots under `snapshot/` in the same manifest. This includes any session files subsequently removed from the live home.

`apps/workspace-bridge/src/box/pi.ts` gives Pi `--session /home/peon/session.jsonl` and starts it in `/work`. The manager binds the persistent home to `/home/peon` and sets `PI_CODING_AGENT_DIR` and `CLAUDE_CONFIG_DIR` within it.

| Home-relative path | Manifest role | Contents |
| --- | --- | --- |
| `session.jsonl` | `authoritative` | The managed Pi session. The file is required once a prompt started. |
| `.pi/agent/sessions/` | `authoritative` | Default sessions from additional Pi invocations. The managed invocation does not create this directory. |
| `.pi/agent/claude-bridge/` | `derived` | Claude bridge state retained with the sessions. |
| `.claude/projects/` | `derived` | Claude Code project transcripts and subagent history. |
| `.codex/sessions/`, `.codex/archived_sessions/`, `.codex/history.jsonl` | `authoritative` | Codex rollouts and command history when a tool runs Codex under the box home. |

Pi's append-only session files hold its complete history. The pinned Claude bridge (`743aaba`, `src/index.ts:1228–1229`) rebuilds its derived Claude Code transcript by design. Export includes surviving abort orphans but cannot retain transcript versions that the bridge already superseded. An empty or absent Claude directory does not block export or delete. The root role describes provenance, not the deletion policy: every archived file must verify in both copies. Export records unreadable derived paths in `skipped`. Delete returns `CustodyIncomplete` until a fresh export includes them.

A missing managed session after a prompt, or a missing home or Pi agent directory, is not a zero-session export. Headers supply session IDs, not permission to discard bytes. The exporter copies empty, headerless, and unfamiliar files and lists their paths under `unparsed` in `manifest.json`. For Claude, the exporter looks for the first JSONL record with a session ID in the first 8 MiB of the file. This only limits ID discovery; the exporter preserves and checksums the entire file. Nested symlink targets are recorded in `SYMLINKS.tsv`; the exporter does not follow them. Hard links are copied as regular files. FIFOs and sockets appear only under `nonData`. Unsafe file names are escaped; `renamed` maps each original path to its checksum-listed path. Custom transcript locations, caches, and provider credentials are outside the archive.

## Owner procedure

Set `MISCHIEF_BOX_ARCHIVE_HOST` to the short hostname of the designated box host in the approved deploy environment. Set `MISCHIEF_BOX_ARCHIVE_PRIMARY` to the same-site NAS's protected `peon-sessions` directory, and `MISCHIEF_BOX_ARCHIVE_REPLICA` to the read-only mount of the second NAS's replicated `peon-sessions` directory. Verify they are different NASes. Only NAS-to-NAS replication writes the second copy. Missing configuration blocks export and delete. There is no custody override.

From an authorized shell with `MISCHIEF_BOX_URL` pointing to the manager, `MISCHIEF_BOX_KEY` injected as a secret, and `PEON_ID` set to the canary:

```sh
printf 'header = "Authorization: Bearer %s"\n' "$MISCHIEF_BOX_KEY" |
  curl --config - --fail-with-body --silent --show-error --json '{}' \
    "$MISCHIEF_BOX_URL/v1/boxes/$PEON_ID/export"
```

Export does not need a `requestId`. An unchanged inventory reuses its verified primary receipt. An optional `row` identifies the requesting desk row; `box_id` names the container. Export writes only the primary and returns `replicaState: "pending"`. The `mirror` field names the expected replica receipt path for intake compatibility, not a proof of replication. Successful destroy returns `replicaState: "verified"`. It checks both archives and compares their receipts and manifest hashes. A missing replica returns `ReplicaPending` with the archive ID; wait for replication and retry DELETE, not export. `ReplicaMismatch` needs a replication repair. Verify both copies before giving `exportReceipt` to Muster as `packet_intake.exportReceipt`.

The receipt records counts for parsed `sessions`, `unparsed` paths, and `skipped` paths, plus the SHA-256 of both `MANIFEST.sha256` and `manifest.json`. The checksum list contains only session files. The manifest's `files` and `bytes` exclude custody metadata and `nonData`. Leave `.incoming-*`, incomplete finals, and published receipts in place. Export still runs inside one HTTP call; asynchronous export is a separate change.

Only after teardown authorization, call `DELETE /v1/boxes/{id}` with a `requestId` and exactly one workspace disposition:

- `landedHead`: the SHA of the commit the desk landed. The manager checks file bytes, executable modes, symlink targets, every ref, linked-worktree HEADs, and every stash entry against that commit. It does not trust workspace Git configuration or the index. Submodules are unsupported. A checkout whose bytes differ from the landed tree because of LFS, line endings, or another checkout filter fails the proof. Only ignore rules from the landed tree can exempt paths; the receipt counts them and lists commits found only in reflogs as `abandoned`. `WorkspaceUnlanded` reports up to 50 dirty paths and the total.
- `discardWorkspace: true`: explicit permission to discard workspace bytes. The manager logs the request ID and supplied `row`, or the authenticated box client if no row is supplied.

Pass `retained: true` to hibernate or to delete a hibernated box to retain the snapshot. Pass `retained: false` to hibernate an already hibernated box to clear retention. Resume clears the flag and makes live `/work` the proof. If destroy removes the superseded snapshot, the response records `snapshotWorkSuperseded: true` and `snapshotBytes`, along with `snapshotKept` and apparent bytes freed. If delete stops after writing its marker, retry with the recorded disposition and retention setting. A different disposition returns `DestroyInProgress` with the original request ID. The retry checks both archive receipts and finishes teardown without reopening the partially removed source. A completed delete returns its original tombstone. Older untracked snapshots and historical orphan directories are not swept by this operation.

For the live hibernated teardown check, submit a valid `landedHead` against a stopped, hibernated canary with manager-owned extracted Git objects. Confirm the proof container can read them as the extraction UID without starting the peon container.
