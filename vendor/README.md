# Vendored packages

Keep pinned dependencies here until npm publishes them. Each entry records its build source and removal condition.

The current `xstate@6.0.0-alpha.65` and `@xstate/effect@0.1.0-alpha.7` pins come from npm. Their exact `minimumReleaseAgeExclude` entries move together. The bridge accepts Effect `^4.0.0` and XState `^6.0.0-alpha.65`.

| Tarball | Built from | Why | Remove when |
| --- | --- | --- | --- |
| `pi-main-73f8de8/*.tgz` (chord, pi-ai, pi-codemode, pi-durable, pi-telemetry) | `earendil-works/pi@73f8de8`, packed once as `1.3.1-main.73f8de8`; hashes in `pi-main-73f8de8/SHA256SUMS` | Unreleased crash-loop guard and SQLite v2 compatibility | npm publishes the matching release; replace all five file overrides and direct pins, then remove this directory and its release-age exceptions |

The last one was `xstate-effect-0.1.0-alpha.2.tgz`, built from the `statelyai/xstate` tag `xstate@6.0.0-alpha.58` with `pnpm exec preconstruct build && pnpm pack` after the first npm publish failed on 2026-09-17. npm published the same bytes on 2026-09-19 and `packages/core` moved to the registry version on 2026-09-20.

## Rules for the next one

- Add a `file:` spec in the consuming package, the tarball here, and a row above with the exact tag or commit it was built from. Build from a pinned tag to keep lockfile integrity reproducible. A moving branch cannot provide that guarantee.
- A `file:` tarball still goes through pnpm's release-age check, which looks the version up on the registry. An unpublished version 404s and fails `pnpm install --frozen-lockfile` in CI; a warm local metadata cache hides this. Every vendored tarball needs a matching version-scoped `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml`.
- When the version publishes, confirm the tarballs match (`npm pack <name>@<version>` and compare file lists and `dist`), replace the `file:` spec with the exact version, delete the tarball and its row, run `pnpm install`, and watch CI. Keep the `minimumReleaseAgeExclude` entry if the package is a prerelease pin like the others in that list.
