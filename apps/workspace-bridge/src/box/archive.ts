import { Context, Data, Effect, Layer, Ref, Schema } from "effect";

import { archiveFailure } from "./archive-failure.js";
import type { ArchiveFailure } from "./archive-failure.js";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

const Stamp = Schema.String.check(Schema.isPattern(/^\d{8}T\d{6}Z$/u));

export const ArchiveName = Schema.String.check(
  Schema.isPattern(/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/u)
);

export const ArchiveReceiptSchema = Schema.Struct({
  authority: Hash,
  box: ArchiveName,
  fingerprint: Hash,
  peon: ArchiveName,
  sha256: Hash,
  stamp: Stamp,
});

export type ArchiveReceipt = typeof ArchiveReceiptSchema.Type;

export const ManifestSchema = Schema.Struct({
  box_id: ArchiveName,
  bytes: Schema.Int,
  created_at: Schema.String,
  exporter: Schema.Literal("mischief-peon-boxes"),
  exporter_version: Schema.Literal("1"),
  files: Schema.Int,
  manifest_sha256: Hash,
  peon_id: ArchiveName,
  repo: Schema.String,
  row: Schema.optionalKey(ArchiveName),
  schema: Schema.Literal("peon-archive.v1"),
  session_ids: Schema.Array(Schema.String),
  source_host: ArchiveName,
  source_roots: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      role: Schema.Literals(["authoritative", "derived"]),
    })
  ),
  unparsed: Schema.Array(Schema.String),
});

export type Manifest = typeof ManifestSchema.Type;

export interface ArchiveFiles {
  readonly authority: string;
  readonly home: string;
  readonly paths: readonly string[];
  readonly checksums: string;
  readonly symlinks: string;
  readonly fingerprint: string;
}

export type ReadBack = Data.TaggedEnum<{
  readonly Mismatch: { readonly reason: string };
  readonly Verified: { readonly exportReceipt: ExportReceipt };
}>;

export const ReadBackResult = Data.taggedEnum<ReadBack>();

export const ExportReceiptSchema = Schema.Struct({
  id: Schema.String,
  sha256: Hash,
  location: Schema.String,
  mirror: Schema.String,
});

type ExportReceipt = typeof ExportReceiptSchema.Type;

export const archiveId = (receipt: ArchiveReceipt) =>
  `${receipt.peon}/${receipt.stamp}-${receipt.box}`;

export const archiveStamp = (iso: string) =>
  iso.replaceAll(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");

export const receiptOf = (
  manifest: Manifest,
  files: ArchiveFiles
): ArchiveReceipt => ({
  authority: files.authority,
  box: manifest.box_id,
  fingerprint: files.fingerprint,
  peon: manifest.peon_id,
  sha256: manifest.manifest_sha256,
  stamp: archiveStamp(manifest.created_at),
});

export class ArchivePort extends Context.Service<
  ArchivePort,
  {
    readonly put: (
      manifest: Manifest,
      files: ArchiveFiles
    ) => Effect.Effect<ArchiveReceipt, ArchiveFailure>;
    readonly readBack: (
      receipt: ArchiveReceipt,
      purpose: "publish" | "check" | "receipts"
    ) => Effect.Effect<ReadBack, ArchiveFailure>;
  }
>()("@mischief/workspace-bridge/ArchivePort") {
  static readonly disabled = Layer.succeed(ArchivePort, {
    put: () =>
      archiveFailure(
        "Protected archive is not configured. Configure both archive roots before exporting."
      ),
    readBack: () =>
      archiveFailure(
        "Protected archive is not configured. Configure both archive roots before destroying."
      ),
  });

  static readonly memory = Layer.effect(
    ArchivePort,
    Effect.gen(function* memoryArchive() {
      const entries = yield* Ref.make(
        new Map<
          string,
          { readonly receipt: ArchiveReceipt; readonly published: boolean }
        >()
      );

      return ArchivePort.of({
        put: Effect.fn("Archive.memoryPut")(
          function* memoryPut(manifest, files) {
            const receipt = receiptOf(manifest, files);
            const id = archiveId(receipt);

            if ((yield* Ref.get(entries)).has(id)) {
              return yield* archiveFailure(
                "Archive timestamp already exists. Retry export with a fresh timestamp."
              );
            }

            yield* Ref.update(entries, (old) =>
              new Map(old).set(id, { published: false, receipt })
            );

            return receipt;
          }
        ),
        readBack: Effect.fn("Archive.memoryReadBack")(
          function* memoryReadBack(receipt, purpose) {
            const id = archiveId(receipt);
            const entry = (yield* Ref.get(entries)).get(id);

            if (
              entry?.receipt.fingerprint !== receipt.fingerprint ||
              entry.receipt.sha256 !== receipt.sha256 ||
              (!entry.published && purpose !== "publish")
            ) {
              return ReadBackResult.Mismatch({
                reason: "In-memory archive has no matching published receipt.",
              });
            }

            yield* Ref.update(entries, (old) =>
              new Map(old).set(id, { ...entry, published: true })
            );

            return ReadBackResult.Verified({
              exportReceipt: {
                id,
                location: `primary/${id}/RECEIPT.json`,
                mirror: `mirror/${id}/RECEIPT.json`,
                sha256: receipt.sha256,
              },
            });
          }
        ),
      });
    })
  );
}
