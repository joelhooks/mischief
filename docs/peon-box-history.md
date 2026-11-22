# Peon box history custody

Export a full-tools box before deleting it. Export stops an idle box and leaves it suspended. It refuses a running box. For a hibernated box it checks the snapshot hash and extracts only the known session roots. It does not start the box or restore the workspace to export history.

`apps/workspace-bridge/src/box/pi.ts` gives Pi `--session /home/peon/session.jsonl` and starts it in `/work`. The manager binds the persistent home to `/home/peon` and sets `PI_CODING_AGENT_DIR` and `CLAUDE_CONFIG_DIR` within it.

| Home-relative path | Manifest role | Contents |
| --- | --- | --- |
| `session.jsonl` | `authoritative` | The managed Pi session. The file is required once a prompt started. |
| `.pi/agent/sessions/` | `authoritative` | Default sessions from additional Pi invocations. The managed invocation does not create this directory. |
| `.claude/projects/` | `derived` | Claude Code project transcripts and subagent history. Collected on a best-effort basis. |
| `.codex/sessions/` | `authoritative` | Codex rollouts if a tool runs Codex under the box home. The box's model proxy does not itself run Codex there. |

Pi's append-only session files hold its complete history. The pinned Claude bridge (`743aaba`, `src/index.ts:1228–1229`) rebuilds its derived Claude Code transcript by design. Export includes surviving abort orphans but cannot retain transcript versions that the bridge already superseded. An empty Claude directory does not block export or delete.

A missing managed session after a prompt, or a missing home or Pi agent directory, is not a zero-session export. Headers supply session IDs, not permission to discard bytes. The exporter copies empty, headerless, and unfamiliar files and lists their paths under `unparsed` in `manifest.json`. Nested symlink targets are recorded in `SYMLINKS.tsv`; the exporter does not follow them. Custom transcript locations, caches, and provider credentials are outside the archive.

## Owner procedure

On the designated box host after an approved deploy, configure `MISCHIEF_BOX_ARCHIVE_HOST` with its short hostname, and `MISCHIEF_BOX_ARCHIVE_PRIMARY` and `MISCHIEF_BOX_ARCHIVE_MIRROR` with the existing protected CIFS roots from the custody contract. Missing configuration blocks export and delete. There is no custody override.

From an authorized shell with `MISCHIEF_BOX_URL` pointing to the manager, `MISCHIEF_BOX_KEY` injected as a secret, and `PEON_ID` set to the canary:

```sh
printf 'header = "Authorization: Bearer %s"\n' "$MISCHIEF_BOX_KEY" |
  curl --config - --fail-with-body --silent --show-error --json '{}' \
    "$MISCHIEF_BOX_URL/v1/boxes/$PEON_ID/export"
```

Export does not need a `requestId`. An unchanged inventory reuses its verified receipt. An optional `row` identifies the requesting desk row when known; `box_id` names the container. Check both returned receipt locations and the manifest digest, then give only `exportReceipt` to Muster as `packet_intake.exportReceipt`. Zero-session exports produce two explicit `sessions: 0` receipts. Leave `.incoming-*`, incomplete finals, and written receipts in place. On a failed publication, retry in a fresh UTC second.

Only after teardown authorization, call `DELETE /v1/boxes/{id}` with a `requestId` and exactly one workspace disposition:

- `landedHead`: the SHA of the commit the desk landed. The box manager checks the commit and refuses if the current workspace or any snapshot it would delete contains work not in that commit. It reports dirty paths as `WorkspaceUnlanded`.
- `discardWorkspace: true`: explicit permission to discard workspace bytes. The manager logs the request ID and supplied `row`, or the authenticated box client if no row is supplied.

Pass `retained: true` to hibernate or to delete a hibernated box to retain the snapshot. The response reports `snapshotKept` and the apparent bytes freed. A delete interrupted after the marker was written can be retried with the same request ID. It checks both archive receipts and finishes teardown without reopening the partially removed source. A completed delete returns its original tombstone. Older untracked snapshots and historical orphan directories are not swept by this operation.
