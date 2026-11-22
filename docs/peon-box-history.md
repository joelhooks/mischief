# Peon box history custody

Export a full-tools box before deleting it. Export stops an idle box and leaves it suspended. It refuses a running box. For a hibernated box it checks the snapshot hash and reads the home from that snapshot without starting a container. It does not export from a box with an ambiguous hibernation state.

The manager owns the only original while a box lives. `apps/workspace-bridge/src/box/pi.ts` gives Pi an explicit `--session /home/peon/session.jsonl` and starts it in `/work`. `apps/workspace-bridge/src/box/manager.ts` binds the persistent home to `/home/peon`, sets `PI_CODING_AGENT_DIR` and `CLAUDE_CONFIG_DIR` there, and creates the Pi agent directory on spawn. The export preserves these home-relative paths:

| Path | What belongs there |
| --- | --- |
| `session.jsonl` | The managed Pi v3 session. Required once a prompt started. |
| `.pi/agent/sessions/` | Default sessions from additional Pi invocations. The managed `--session` invocation does not create this directory. |
| `.claude/projects/` | Claude Code project transcripts and nested subagent history. The pinned `pi-claude-bridge` (`743aaba`, `src/index.ts:1026,1098,1228–1235`) reads and writes them in its configured Claude directory. |
| `.codex/sessions/` | Codex rollouts when a tool invokes Codex under the box home. The box's model proxy does not itself run Codex in that home. |

A missing managed session after a prompt, or a missing home or Pi agent directory, is not a zero-session export. Additional roots are optional; the manager does not provision them. Other directories (including caches, provider credentials, worktrees and request output) are not archive inputs. Tools that put transcripts in a custom location outside the supported roots are not covered. Archive metadata records nested links in `SYMLINKS.tsv` and does not copy their targets.

This is a final export of the current session set, not write-through capture. The pinned Claude bridge can replace a transcript during a rebuild (`src/index.ts:1228–1229`). A teardown export cannot recover bytes already replaced during an earlier turn.

## Owner procedure

On the designated box host, after the approved deploy, set `MISCHIEF_BOX_ARCHIVE_PRIMARY` and `MISCHIEF_BOX_ARCHIVE_MIRROR` to the two pre-existing `peon-sessions` directories in the custody contract. Both must be on the protected CIFS mounts. Without both settings the manager refuses export and destroy; there is no override. Configuration, mount access and retention policy are operator-owned.

From an authorized shell on that host, with `MISCHIEF_BOX_URL` pointing at the box manager, `MISCHIEF_BOX_KEY` injected as a secret, and `PEON_ID` set to the canary:

```sh
printf 'header = "Authorization: Bearer %s"\n' "$MISCHIEF_BOX_KEY" |
  curl --config - --fail-with-body --silent --show-error \
    --json "{\"requestId\":\"custody-${PEON_ID}-$(date -u +%Y%m%dT%H%M%SZ)\"}" \
    "$MISCHIEF_BOX_URL/v1/boxes/$PEON_ID/export"
```

Check the returned `exportReceipt` (`id`, `sha256`, `location`, `mirror`) against both protected directories. Give that object to Muster as `packet_intake.exportReceipt`; do not send session bytes or archive listings. A zero-session box produces two explicit `sessions: 0` receipts. Only after separate teardown authorization, use `DELETE /v1/boxes/{id}` with a fresh `requestId`. Delete compares the stopped source inventory with the recorded fingerprint and reads both final copies and receipts again. A refused delete must be retried with a new request ID after recovery.

Successful exports of unchanged bytes reuse the verified receipt. An interrupted attempt can leave `.incoming-*`; a host crash during the two independent promotions can also leave an incomplete final. Neither is authority to destroy. Leave existing archives alone and retry export in a fresh UTC second. A current hibernation snapshot is removed after verified destroy unless explicitly marked `snapshot.retained: true` in its host-owned record. A resumed box with an earlier unmarked snapshot refuses teardown. Older untracked snapshot files and orphan directories are outside this packet; do not sweep them.
