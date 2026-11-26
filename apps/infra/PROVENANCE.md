# Caller generator provenance

The probe/canary and Pi session regexes in [`generate-callers.ts`](./generate-callers.ts) are copied unchanged from Rat King's [`ephemeralName` at `5fa7103`, `packages/ratking-client/src/directory-view.ts:16–20`](https://github.com/joelhooks/rat-king/blob/5fa7103/packages/ratking-client/src/directory-view.ts#L16-L20). The generator counts excluded rows by the first matching class and never filters the trusted seed.
