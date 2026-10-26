# Alpha.65 persistence fixtures

`runs.json.gz` is the gzip of `runs.json` (8,748,281 bytes raw, 197,706 gzipped). It was captured before the dependency bump, on commit `7a986e399b807a6b99e66875cbddd767c29b5f5e`, with `xstate@6.0.0-alpha.65`, `@xstate/effect@0.1.0-alpha.7` and Effect `4.0.1`.

The corpus contains 27 plans and 837 atomic `RunBackend.apply` captures. Each capture contains the persisted run state, documents, journal, fingerprints, message-owner index and pause flag. Each plan also carries its original submission body, normalized stored plan, compiled machine JSON, submission fingerprint, completed step fingerprints and the old engine's final value and documents.

The plans combine one to three sequential think steps, two to four parallel branches and three prompt values. Every branch thinks, sends an ask and waits for a reply. The joined branches reach an operator question, then a final state. The initial documents include a seed that must survive every restore.

The captures cover:

- 675 running checkpoints, including active think invocations, parallel branches and unconsumed completion events;
- 81 waiting-for-reply states, including partially answered fan-outs;
- 54 waiting-for-operator states;
- 27 completed runs.

The generation seed is `650070`. `capture.ts` retains the generator and refuses manifests with different engine pins. To regenerate, use the source commit above, copy this generator and the migration test helpers into that checkout, and invoke `captureAlpha65` from a temporary `it.effect` test. Run Vitest with `--maxWorkers=4`. Never regenerate this corpus using the new engine.

## Integrity

The decompressed content is byte-identical to the former `runs.json`, whose sha256 was `5f59054a74dd1ac3d6793b4f4fd7408d39640e513347ccc47ef6bd0e28e7258d`. Check it with `gunzip -c runs.json.gz | sha256sum`. `migration-corpus.ts` decodes the file with `gunzipSync`; a corrupt archive fails with `CorpusDecodeError`. `capture.ts` writes gzip.

## Compatibility checks

`xstate-migration.test.ts` reopens every capture through the real run host, resubmits the original body and completes the run. It compares final values and documents with the old engine's recorded result. It also checks that compiled JSON and submission fingerprints are unchanged, and that fresh executions retain every completed step fingerprint.

The generated property selects a plan from the fully captured family, a saved commit boundary, restart and pause histories, and reply ordering. Its seed is `700065`; it runs 100 histories. The existing durability model property supplies broader graph and crash-schedule coverage on the new engine.

A temporary restore adapter deleted the snapshot's `value` field. The generated property failed on its first run and shrank three times to a one-think, two-branch plan restored from capture 1 with no extra pauses. The failure was `InvalidSnapshotError: Persisted snapshot for machine 'migration' has no state value.` Replay: `[0,"700065",0,0,[1,1,0],"PropertyError"]`. The plant was removed after this red proof.

## Engine boundary

The compiler still emits the same JSON. `hydratePlan` preserves the old invoke ids explicitly and translates suffixed state-completion selectors into the new category-and-payload form. `restorePlanSnapshot` converts the old empty timer record into the new empty timer list. Plans cannot declare timers, so this adapter does not invent timer migrations the grammar cannot reach.

The bridge clock property separately checks persisted deadlines against Effect's `TestClock` and checks the new `$actor` serialization envelope.

Alpha.65 already changes an in-flight think's step fingerprint on restore because its saved input contains enriched agent defaults. The compatibility check therefore compares fresh-execution step hashes, not an invariant that the old engine itself violates. Submission/body fingerprints remain unchanged across restores.
