# Refresh celld callers before a deploy

Rat King's issuer owns the directory and retirement data. Export a fresh directory with a configured Rat King signing identity injected as `RATKING_IDENTITY_JSON` by the secret runner. The exporter uses the Rat King transport to page `identity.listNames` with `all: true`. Its output contains only the name, DID, public document, and optional status. The generator never takes identity credentials.

```sh
umask 077
RUN_DIR=$(mktemp -d)
pnpm --filter @mischief/infra export-fleet-directory \
  "$MAILBOX_ORIGIN" "$MAILBOX_SERVICE_DID" --out "$RUN_DIR/directory.json"

pnpm --filter @mischief/infra generate-callers \
  "$RUN_DIR/directory.json" "$LEGACY_CALLERS_FILE" "$RUN_DIR/callers.json"
```

`LEGACY_CALLERS_FILE` is the trusted, hand-maintained public seed, **not** a previous generated file. The generator keeps the seed documents and grants byte for byte. It adds public documents for non-retired fleet names, without mail or Peon grants, and prints only the counts. Use a new output path each time. Using a previous generated file as the seed would retain names retired since that deploy.

Load the existing celld deploy configuration as usual. Set `MISCHIEF_STATE_DIR` to the existing external Alchemy state directory. Use the same caller file for the offline plan and the approved deploy:

```sh
export MISCHIEF_TARGET=celld ALCHEMY_TELEMETRY_DISABLED=1 MISCHIEF_ONLINE_PLAN=false
export MISCHIEF_CALLERS_FILE="$RUN_DIR/callers.json"
export MISCHIEF_PLAN_OUT="$RUN_DIR/plan.json"
pnpm --filter @mischief/infra plan

# After reviewing the offline plan and receiving approval:
MISCHIEF_CELLD_APPROVED=true MISCHIEF_REVIEW="$REVIEW_IDS" \
  pnpm --filter @mischief/infra deploy
```

Stop if the plan refuses a delete or replacement. After deploy, test a read-only call signed by a newly added identity. To roll back the caller expansion, point `MISCHIEF_CALLERS_FILE` at the previously deployed caller file and repeat the plan and approval process. New registrations and retirements take effect at the next refresh and deploy, not at request time.
