# Refresh the celld caller file

Run from the Mischief checkout with the existing celld settings and Rat King operator credentials loaded. `MISCHIEF_STATE_DIR` must point to the existing external Alchemy state. Use absolute paths for every input file and directory, including a snapshot or legacy export supplied by the rats-nest desk.

- `CALLER_ARCHIVE`: an existing, private, durable directory outside the repo. Do not use `/tmp`.
- `PREVIOUS_CALLERS_FILE`: the trusted file used in the current deployment. Copy it into the archive before planning so rollback does not depend on a mutable path.
- `LEGACY_CALLERS_FILE`: the original trusted seed with existing grants. Do not use a previous generated file as the seed.
- `RESERVED_PUBLIC_FILE`: the fleet-only public `DID_DOCUMENTS` array, prepared separately from the snapshot.
- `EXTRA_PUBLIC_FILE`: public `[{"name":"…","document":{…}}]` entries for callers missing from the directory. This is a stopgap until Rat King backfills the old rows and includes reserved names in snapshots.

## Pre-deploy dry run on real inputs

Use the first real Rat King snapshot, the real fleet-only `DID_DOCUMENTS` array, the real 11-document extras file, and the real legacy seed. The generator checks that the seed passes and prints the caller counts. The two `jq` checks below confirm that all seed entries and grants are unchanged and that the generated caller file contains all 11 distinct extra DIDs. The total can be higher than 11: it also includes the seed, reserved, and directory callers.

```sh
set -eu
for input in "$CALLER_ARCHIVE" "$MISCHIEF_STATE_DIR" "$PREVIOUS_CALLERS_FILE" \
  "$LEGACY_CALLERS_FILE" "$RESERVED_PUBLIC_FILE" "$EXTRA_PUBLIC_FILE"; do
  case "$input" in
    /*) ;;
    *) printf 'Expected an absolute input path: %s\n' "$input" >&2; exit 1 ;;
  esac
done
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
jq -en --slurpfile seed "$LEGACY_CALLERS_FILE" --slurpfile generated "$RUN_DIR/callers.json" \
  '$generated[0][0:($seed[0] | length)] == $seed[0]'
jq -en --slurpfile extras "$RUN_DIR/extras.json" --slurpfile generated "$RUN_DIR/callers.json" \
  '($extras[0] | map(.document.id) | unique) as $expected |
   ($generated[0] | map(.id)) as $actual |
   ($expected | length) == 11 and (($expected - $actual) | length) == 0'
export MISCHIEF_TARGET=celld ALCHEMY_TELEMETRY_DISABLED=1 MISCHIEF_ONLINE_PLAN=false
export MISCHIEF_CALLERS_FILE="$RUN_DIR/callers.json"
export MISCHIEF_PLAN_OUT="$RUN_DIR/plan.json"
mise exec pnpm@11.3.0 -- pnpm --filter @mischief/infra plan
```

Inspect `$RUN_DIR/plan.json`. It must show only the caller allowlist update. Stop before deploy if it shows any unrelated change, deletion, or replacement. This is the real-bytes check; the repository tests use synthetic data.

The plan driver reads `MISCHIEF_ONLINE_PLAN` in [`plan.ts:37`](./plan.ts#L37) and `MISCHIEF_PLAN_OUT` in [`plan-runtime.ts:109`](./plan-runtime.ts#L109). The caller config reads `MISCHIEF_CALLERS_FILE` in [`callers.ts:130`](./callers.ts#L130).

Invoke the Rat King binary directly for clean JSON stdout. Rat King's `apps/ratking-cli/src/snapshot.ts:215–226` writes only `names.json`, `retired.json`, and `issuers.json`. `apps/ratking-cli/src/snapshot-command.ts:125` writes the JSON receipt to stdout, not to `manifest.json`. That is why the command above moves the captured receipt into the bundle. If rats-nest supplies the first real bundle, archive its files and original receipt instead of recapturing them. The manifest verifies file integrity, not origin, and cannot tell you whether an issuer is missing. A complete legacy directory export can replace the first generator argument; the legacy three-argument form also remains supported.

The bundle stays at `$RUN_DIR/snapshot`. Use `$RUN_DIR/callers.json` for the reviewed plan and any separately approved deploy. For rollback, set `MISCHIEF_CALLERS_FILE` to `$RUN_DIR/previous-callers.json`, set `MISCHIEF_PLAN_OUT` to `$RUN_DIR/rollback-plan.json`, and run the same offline plan before seeking approval.
