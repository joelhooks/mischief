# Refresh the celld caller file

Run from the Mischief checkout with the existing celld settings and Rat King operator credentials loaded. `MISCHIEF_STATE_DIR` must point to the existing external Alchemy state.

- `CALLER_ARCHIVE`: an existing, private, durable directory outside the repo. Do not use `/tmp`.
- `PREVIOUS_CALLERS_FILE`: the trusted file used in the current deployment. Copy it into the archive before planning so rollback does not depend on a mutable path.
- `LEGACY_CALLERS_FILE`: the original trusted seed with existing grants. Do not use a previous generated file as the seed.
- `RESERVED_PUBLIC_FILE`: the fleet-only public `DID_DOCUMENTS` array, prepared separately from the snapshot.
- `EXTRA_PUBLIC_FILE`: public `[{"name":"…","document":{…}}]` entries for callers missing from the directory. This is a stopgap until Rat King backfills the old rows and includes reserved names in snapshots.

```sh
set -eu
umask 077
RUN_DIR=$(mktemp -d "$CALLER_ARCHIVE/refresh.XXXXXXXX")
install -m 600 "$PREVIOUS_CALLERS_FILE" "$RUN_DIR/previous-callers.json"
ratking snapshot --out "$RUN_DIR/snapshot" > "$RUN_DIR/receipt.json"
mv "$RUN_DIR/receipt.json" "$RUN_DIR/snapshot/manifest.json"
install -m 600 "$RESERVED_PUBLIC_FILE" "$RUN_DIR/reserved.json"
install -m 600 "$EXTRA_PUBLIC_FILE" "$RUN_DIR/extras.json"
mise exec pnpm@11.3.0 -- pnpm --filter @mischief/infra generate-callers \
  "$RUN_DIR/snapshot" "$LEGACY_CALLERS_FILE" "$RUN_DIR/callers.json" \
  "$RUN_DIR/reserved.json" "$RUN_DIR/extras.json"
export MISCHIEF_TARGET=celld ALCHEMY_TELEMETRY_DISABLED=1 MISCHIEF_ONLINE_PLAN=false
export MISCHIEF_CALLERS_FILE="$RUN_DIR/callers.json"
export MISCHIEF_PLAN_OUT="$RUN_DIR/plan.json"
mise exec pnpm@11.3.0 -- pnpm --filter @mischief/infra plan
```

The bundle stays at `$RUN_DIR/snapshot`. The new caller file stays at `$RUN_DIR/callers.json`; rollback uses `$RUN_DIR/previous-callers.json`. Use the generated file for both the reviewed plan and any separately approved deploy. For rollback, set `MISCHIEF_CALLERS_FILE` to the saved previous file, set `MISCHIEF_PLAN_OUT` to `$RUN_DIR/rollback-plan.json`, and run the same offline plan before seeking approval. Stop if the plan deletes or replaces a resource.

Invoke the Rat King binary directly for clean JSON stdout. The manifest checks file integrity, not who produced the bundle. Use the first real bundle from the rats-nest desk to verify generation and the offline plan before any deploy. A complete legacy directory export can replace the first generator argument; the legacy three-argument form also remains supported.
