# SQLite upgrade proof

Run this from the repository root after installing the vendored pi main packages:

```sh
legacy=$(mktemp -d)
pnpm --dir "$legacy" add --ignore-scripts @earendil-works/pi-durable@1.1.0
node packages/thinking/test/sqlite-upgrade-proof.ts \
  "$legacy/node_modules/@earendil-works/pi-durable"
```

The proof installs no dependencies in this workspace and calls no models. The first argument must name an installed pi-durable 1.1.0 package. It resolves symlinks before finding that package's dependencies.

The fixture runs under 1.1.0 to write a real SQLite v1 store with a conversation, entry, pending task, and `mischief.steps` document. After closing the store and checkpointing its WAL, the proof copies the file. The current adapter opens only the copy, migrates it to v2, and reads back every seeded record unchanged.

The original must remain byte-identical and at schema v1. The 1.1.0 adapter must still open it and read all the records. That adapter must reject the migrated copy as newer than its supported schema.

Success exits 0 and prints:

```json
{
  "migratedVersion": 2,
  "originalUnchanged": true,
  "originalVersion": 1,
  "preserved": ["conversation", "entry", "task", "mischief.steps"],
  "rollback": "1.1.0 opens the original and rejects the migrated copy"
}
```

This is an offline compatibility proof, not a live snapshot or deployment. A deployment still needs approval, a snapshot of the actual store before the new adapter opens it, and a resume check. Rolling back to 1.1.0 requires the untouched pre-upgrade snapshot; it cannot use the migrated database.
