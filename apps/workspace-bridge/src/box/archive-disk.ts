import { hostname } from "node:os";

import {
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import type { PlatformError } from "effect";

import { Runner } from "../runner.js";
import { archiveFailure } from "./archive-failure.js";
import type { ArchiveFailure } from "./archive-failure.js";
import {
  fingerprintOf,
  isArchivePath,
  sha256,
  walkArchive,
} from "./archive-source.js";
import {
  ArchivePort,
  ArchiveReceiptSchema,
  ManifestSchema,
  ReadBackResult,
  archiveId,
  archiveStamp,
  receiptOf,
} from "./archive.js";
import type {
  ArchiveFiles,
  ArchiveReceipt,
  Manifest,
  ReadBack,
} from "./archive.js";
import { custodyMissing } from "./custody-missing.js";

const disjoint = (primary: string, replica: string) =>
  primary !== replica &&
  !primary.startsWith(`${replica}/`) &&
  !replica.startsWith(`${primary}/`);

const checksumPaths = Effect.fn("Archive.checksumPaths")(
  function* checksumPaths(checksums: string, manifest: Manifest) {
    const listed = new Set<string>();

    for (const line of checksums.split("\n").slice(0, -1)) {
      const name = line.slice(66);

      if (
        !/^[a-f0-9]{64} {2}/u.test(line) ||
        !isArchivePath(name) ||
        listed.has(name)
      ) {
        return yield* archiveFailure(
          "Archive checksum manifest contains an invalid or duplicate session path."
        );
      }

      listed.add(name);
    }

    const renamed = manifest.renamed ?? [];

    if (
      new Set(renamed.map(({ from }) => from)).size !== renamed.length ||
      renamed.some(({ to }) => !listed.has(to)) ||
      (manifest.nonData ?? []).some(({ path: name }) => listed.has(name))
    ) {
      return yield* archiveFailure(
        "Archive rename or non-data inventory does not match the checksum manifest."
      );
    }

    return listed;
  }
);

const mountTypes = new Set(["ff534d42", "fe534d42"]);

const receiptName = "RECEIPT.json";

const manifestName = "manifest.json";

const checksumsName = "MANIFEST.sha256";

const linksName = "SYMLINKS.tsv";

const metadataNames = new Set([
  receiptName,
  manifestName,
  checksumsName,
  linksName,
]);

const DiskReceipt = Schema.fromJsonString(
  Schema.Struct({
    bytes: Schema.Int,
    checker_host: Schema.String,
    dirs: Schema.Array(Schema.String),
    files: Schema.Int,
    manifest_sha256: Schema.String,
    manifest_json_sha256: Schema.String,
    ok: Schema.Literal(true),
    primary_root: Schema.String,
    rc: Schema.Literal(0),
    replica_root: Schema.String,
    sessions: Schema.Int,
    unparsed: Schema.Int,
    skipped: Schema.Int,
    verified_at: Schema.String,
  })
);

const onArchiveHost = Effect.fn("Archive.checkMount")(function* onArchiveHost(
  directory: string,
  runner: typeof Runner.Service,
  checkerHost: string
) {
  if (hostname().split(".")[0] !== checkerHost) {
    return yield* archiveFailure(
      "Protected archive can run only on the designated box host. Retry there after checking custody mounts."
    );
  }

  const output = yield* runner
    .run({ executable: "stat", args: ["-f", "-c", "%t", "--", directory] })
    .pipe(
      Effect.mapError(() =>
        archiveFailure(
          "Archive mount is not reachable. Restore both custody mounts before retrying export."
        )
      )
    );

  if (output.exit !== 0 || !mountTypes.has(output.stdout.trim())) {
    return yield* archiveFailure(
      "Protected archive root is not a CIFS mount. Restore custody storage and retry."
    );
  }

  return yield* Effect.void;
});

interface ArchiveRoots {
  readonly checkerHost: string;
  readonly primary: string;
  readonly replica: string;
}

export const archiveDiskLayer = (
  roots: ArchiveRoots,
  checkMount: (
    directory: string,
    runner: typeof Runner.Service,
    checkerHost: string
  ) => Effect.Effect<void, ArchiveFailure> = onArchiveHost
) =>
  Layer.effect(
    ArchivePort,
    Effect.gen(function* makeArchiveDisk() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* Runner;

      const verifyDirectory = Effect.fn("Archive.verifyDirectory")(
        function* verifyDirectory(directory: string) {
          if (
            (yield* fs.lstat(directory)).type !== "Directory" ||
            (yield* fs.realPath(directory)) !== directory
          ) {
            return yield* archiveFailure(
              "Archive directory is not canonical. Repair the configured custody directories before retrying."
            );
          }

          return yield* Effect.void;
        }
      );

      const mount = Effect.fn("Archive.mount")(function* mount(root: string) {
        const missing = () =>
          custodyMissing(
            root,
            "Archive mount could not be read. Restore custody storage and retry."
          );

        const canonical = yield* fs
          .realPath(root)
          .pipe(Effect.mapError(missing));

        yield* fs.readDirectory(canonical).pipe(Effect.mapError(missing));
        yield* checkMount(canonical, runner, roots.checkerHost).pipe(
          Effect.mapError((error) => custodyMissing(root, error.message))
        );

        return canonical;
      });

      const prepare = Effect.gen(function* prepare() {
        for (const root of [roots.primary, roots.replica]) {
          if (
            !path.isAbsolute(root) ||
            root === "/" ||
            path.normalize(root) !== root ||
            root.endsWith("/") ||
            /[\r\n]/u.test(root)
          ) {
            return yield* archiveFailure(
              "Archive roots must be absolute directories other than /. Correct the custody configuration."
            );
          }
        }

        if (!disjoint(roots.primary, roots.replica)) {
          return yield* archiveFailure(
            "Archive roots must be disjoint. Correct the custody configuration."
          );
        }

        const primary = yield* mount(roots.primary);
        const replica = yield* fs.realPath(roots.replica).pipe(Effect.option);

        if (Option.isSome(replica) && !disjoint(primary, replica.value)) {
          return yield* archiveFailure(
            "Replica resolves to the primary custody tree. Correct the replica mount."
          );
        }

        return primary;
      });

      const layout = (root: string, receipt: ArchiveReceipt) => ({
        final: path.join(root, archiveId(receipt)),
        incoming: path.join(
          root,
          receipt.peon,
          `.incoming-${receipt.box}-${receipt.stamp}`
        ),
        parent: path.join(root, receipt.peon),
      });

      const command = Effect.fn("Archive.command")(function* command(
        executable: string,
        args: readonly string[],
        input?: string
      ) {
        const invocation =
          input === undefined
            ? { args, executable }
            : { args, executable, input };

        const output = yield* runner
          .run(invocation)
          .pipe(
            Effect.mapError(() =>
              archiveFailure(
                `Could not run ${executable} for protected history. Check host tools and retry export.`
              )
            )
          );

        if (output.exit !== 0) {
          return yield* archiveFailure(
            `${executable} exited ${output.exit} during protected export. Check archive storage and retry export with a fresh request.`
          );
        }

        return yield* Effect.void;
      });

      const readText = Effect.fn("Archive.metadataText")(function* readText(
        directory: string,
        name: string
      ) {
        const file = path.join(directory, name);

        const stat = yield* fs
          .lstat(file)
          .pipe(
            Effect.mapError(() =>
              archiveFailure(
                `Archive ${name} is missing or unreadable. Check both custody copies.`
              )
            )
          );

        if (stat.type !== "File") {
          return yield* archiveFailure(
            "Archive metadata is not a regular file. Inspect custody copies and retry export."
          );
        }

        return yield* fs.readFileString(file);
      });

      const check = Effect.fn("Archive.check")(function* check(
        directory: string,
        receipt: ArchiveReceipt
      ) {
        yield* verifyDirectory(directory);

        const manifestJson = yield* readText(directory, manifestName);

        const manifest = yield* Schema.decodeEffect(
          Schema.fromJsonString(ManifestSchema)
        )(manifestJson).pipe(
          Effect.mapError(() =>
            archiveFailure(
              "Archive manifest is invalid. Inspect custody copies and retry export."
            )
          )
        );

        const checksums = yield* readText(directory, checksumsName);
        const links = yield* readText(directory, linksName);

        if (
          manifest.peon_id !== receipt.peon ||
          manifest.box_id !== receipt.box ||
          archiveStamp(manifest.created_at) !== receipt.stamp ||
          sha256(manifestJson) !== receipt.manifestJsonSha256 ||
          manifest.manifest_sha256 !== receipt.sha256 ||
          sha256(checksums) !== receipt.sha256 ||
          fingerprintOf(
            checksums,
            links,
            manifest.session_ids,
            manifest.renamed,
            manifest.nonData
          ) !== receipt.fingerprint
        ) {
          return yield* archiveFailure(
            "Archive manifest differs from the source inventory. Inspect both custody copies and retry export."
          );
        }

        const listed = yield* checksumPaths(checksums, manifest);
        let bytes = 0;
        let files = 0;
        yield* walkArchive(directory, "", (name, stat) =>
          Effect.gen(function* countArchiveFile() {
            if (stat.type !== "File") {
              return yield* archiveFailure(
                "Archive has a symlink or special file on disk. Inspect custody copies and retry export."
              );
            }

            if (!metadataNames.has(name)) {
              if (!listed.has(name)) {
                return yield* archiveFailure(
                  "Archive contains a file not listed in the checksum manifest."
                );
              }

              bytes += Number(stat.size);
              files += 1;
            }

            return yield* Effect.void;
          })
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path)
        );

        if (
          files !== manifest.files ||
          bytes !== manifest.bytes ||
          files !== checksums.split("\n").length - 1
        ) {
          return yield* archiveFailure(
            "Archive file count or byte count differs from the manifest. Inspect custody copies and retry export."
          );
        }

        if (files !== 0) {
          yield* command("env", [
            "-C",
            directory,
            "sha256sum",
            "-c",
            "--strict",
            "--quiet",
            checksumsName,
          ]).pipe(
            Effect.mapError(() =>
              archiveFailure(
                "sha256sum verification failed for protected history. Check both custody copies before retrying."
              )
            )
          );
        }

        return manifest;
      });

      const put = Effect.fn("Archive.diskPut")(
        function* put(
          primary: string,
          manifest: Manifest,
          files: ArchiveFiles
        ) {
          const receipt = yield* Schema.decodeEffect(
            Schema.Tuple([ManifestSchema, ArchiveReceiptSchema])
          )([manifest, receiptOf(manifest, files)]).pipe(
            Effect.mapError(() =>
              archiveFailure(
                "Archive identity or manifest is invalid. Correct the box identity before retrying export."
              )
            ),
            Effect.map(([, value]) => value)
          );

          if (![...files.sources.keys()].every(isArchivePath)) {
            return yield* archiveFailure(
              "Archive file is outside the permitted session roots. Inspect the stopped box before retrying export."
            );
          }

          if (manifest.bytes > 50_000_000_000) {
            yield* Effect.logWarning(
              "Peon raw history exceeds 50 GB; exporting without a cap"
            );
          }

          {
            const { final, incoming, parent } = layout(primary, receipt);
            yield* fs.makeDirectory(parent, { mode: 0o700, recursive: true });
            yield* verifyDirectory(parent);

            if (yield* fs.exists(final)) {
              return yield* archiveFailure(
                "Archive final directory already exists. Export again with a fresh timestamp; existing archives are write-once."
              );
            }

            yield* fs.makeDirectory(incoming, { mode: 0o700 });

            for (const [name, source] of files.sources) {
              const destination = path.join(incoming, name);
              yield* fs.makeDirectory(path.dirname(destination), {
                recursive: true,
                mode: 0o700,
              });
              yield* fs.copyFile(source, destination);
            }

            yield* fs.writeFileString(
              path.join(incoming, checksumsName),
              files.checksums,
              { mode: 0o600 }
            );
            yield* fs.writeFileString(
              path.join(incoming, linksName),
              files.symlinks,
              { mode: 0o600 }
            );
            yield* fs.writeFileString(
              path.join(incoming, manifestName),
              JSON.stringify(manifest),
              { mode: 0o600 }
            );
          }

          return receipt;
        },
        Effect.catchTag("PlatformError", () =>
          archiveFailure(
            "Could not stage protected history on the primary. Check the custody mount and retry export with a fresh timestamp."
          )
        )
      );

      const checkReceipt = Effect.fn("Archive.checkReceipt")(
        function* checkReceipt(
          directory: string,
          manifest: Manifest,
          dirs: readonly string[],
          receipt: ArchiveReceipt
        ) {
          yield* verifyDirectory(directory);

          const text = yield* readText(directory, receiptName);

          const proof = yield* Schema.decodeEffect(DiskReceipt)(text).pipe(
            Effect.mapError(() =>
              archiveFailure(
                "Protected archive receipt is missing or invalid. Retry export before destroying."
              )
            )
          );

          if (
            proof.manifest_sha256 !== receipt.sha256 ||
            proof.manifest_json_sha256 !== receipt.manifestJsonSha256 ||
            proof.sessions !== receipt.counts?.sessions ||
            proof.unparsed !== receipt.counts?.unparsed ||
            proof.skipped !== receipt.counts?.skipped ||
            proof.checker_host !== roots.checkerHost ||
            proof.primary_root !== roots.primary ||
            proof.replica_root !== roots.replica ||
            JSON.stringify(proof.dirs) !== JSON.stringify(dirs) ||
            proof.bytes !== manifest.bytes ||
            proof.files !== manifest.files
          ) {
            return yield* archiveFailure(
              "Protected archive receipt differs from the verified inventory. Retry export before destroying."
            );
          }

          return text;
        }
      );

      const publish = Effect.fn("Archive.publish")(function* publish(
        receipt: ArchiveReceipt,
        location: ReturnType<typeof layout>,
        dirs: readonly string[]
      ) {
        const { incoming, final } = location;
        yield* check(incoming, receipt);
        yield* command("mv", ["-T", "-n", "--", incoming, final]);

        if (yield* fs.exists(incoming)) {
          return yield* archiveFailure(
            "Final archive already exists. Leave it untouched and retry export."
          );
        }

        const manifest = yield* check(final, receipt);
        const verifiedAt = DateTime.formatIso(yield* DateTime.now);

        const evidence = {
          bytes: manifest.bytes,
          checker_host: roots.checkerHost,
          dirs,
          files: manifest.files,
          manifest_sha256: receipt.sha256,
          manifest_json_sha256: receipt.manifestJsonSha256,
          sessions: manifest.session_ids.length,
          unparsed: manifest.unparsed.length,
          skipped: manifest.skipped.length,
          ok: true,
          primary_root: roots.primary,
          rc: 0,
          replica_root: roots.replica,
          verified_at: verifiedAt,
        };

        yield* fs.writeFileString(
          path.join(final, receiptName),
          JSON.stringify(evidence),
          { flag: "wx", mode: 0o600 }
        );

        return manifest;
      });

      const checkReplica = Effect.fn("Archive.checkReplica")(
        function* checkReplica(
          primary: string,
          receipt: ArchiveReceipt,
          dirs: readonly string[],
          primaryText: string
        ) {
          const replica = yield* mount(roots.replica);

          if (!disjoint(primary, replica)) {
            return yield* archiveFailure(
              "Replica resolves to the primary custody tree. Correct the replica mount."
            );
          }

          const { final } = layout(replica, receipt);

          if (!(yield* fs.exists(path.join(final, receiptName)))) {
            return ReadBackResult.ReplicaPending({
              reason:
                "The replica has not copied the completed archive. Wait for NAS replication and retry DELETE.",
            });
          }

          const manifest = yield* check(final, receipt);

          const replicaText = yield* checkReceipt(
            final,
            manifest,
            dirs,
            receipt
          );

          if (replicaText !== primaryText) {
            return yield* archiveFailure(
              "Replica receipt bytes differ from the primary. Repair replication and retry DELETE."
            );
          }

          return null;
        },
        Effect.catchTags({
          CustodyMissing: () =>
            Effect.succeed(
              ReadBackResult.ReplicaPending({
                reason:
                  "Replica mount is unavailable. Restore it, wait for replication, and retry DELETE.",
              })
            ),
          ArchiveFailure: (error) =>
            Effect.succeed(
              ReadBackResult.ReplicaMismatch({ reason: error.message })
            ),
          PlatformError: () =>
            Effect.succeed(
              ReadBackResult.ReplicaMismatch({
                reason:
                  "Replica files could not be read. Repair replication and retry DELETE.",
              })
            ),
        })
      );

      const readBack = Effect.fn("Archive.diskReadBack")(
        function* readBack(
          primary: string,
          receipt: ArchiveReceipt,
          purpose: "check" | "publish" | "primary"
        ): Effect.fn.Return<
          ReadBack,
          ArchiveFailure | PlatformError.PlatformError
        > {
          const location = layout(primary, receipt);
          const replica = layout(roots.replica, receipt);
          const dirs = [layout(roots.primary, receipt).final, replica.final];

          const manifest =
            purpose === "publish"
              ? yield* publish(receipt, location, dirs)
              : yield* check(location.final, receipt);

          const text = yield* checkReceipt(
            location.final,
            manifest,
            dirs,
            receipt
          );

          if (purpose === "check") {
            const failure = yield* checkReplica(primary, receipt, dirs, text);

            if (failure !== null) {
              return failure;
            }
          }

          return ReadBackResult.Verified({
            exportReceipt: {
              id: archiveId(receipt),
              location: path.join(dirs[0] ?? location.final, receiptName),
              mirror: path.join(replica.final, receiptName),
              primaryRoot: roots.primary,
              replicaRoot: roots.replica,
              replicaState: purpose === "check" ? "verified" : "pending",
              sha256: receipt.sha256,
            },
          });
        },
        Effect.catchTags({
          ArchiveFailure: (failure) =>
            Effect.succeed(
              ReadBackResult.Mismatch({ reason: failure.message })
            ),
          PlatformError: () =>
            Effect.succeed(
              ReadBackResult.Mismatch({
                reason:
                  "Archive file or mount could not be read. Check both custody roots before retrying.",
              })
            ),
        })
      );

      return ArchivePort.of({
        open: prepare.pipe(
          Effect.map((primary) => ({
            put: (manifest: Manifest, files: ArchiveFiles) =>
              put(primary, manifest, files),
            readBack: (
              receipt: ArchiveReceipt,
              purpose: "check" | "publish" | "primary"
            ) => readBack(primary, receipt, purpose),
          }))
        ),
      });
    })
  );
