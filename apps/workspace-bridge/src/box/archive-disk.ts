import { hostname } from "node:os";

import { DateTime, Effect, FileSystem, Layer, Path, Schema } from "effect";
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
import type { ArchiveReceipt, Manifest, ReadBack } from "./archive.js";

export const archiveHost = "pennywise";

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
    checker_host: Schema.Literal(archiveHost),
    dirs: Schema.Array(Schema.String),
    files: Schema.Int,
    manifest_sha256: Schema.String,
    ok: Schema.Literal(true),
    rc: Schema.Literal(0),
    sessions: Schema.optionalKey(Schema.Literal(0)),
    verified_at: Schema.String,
  })
);

const onArchiveHost = Effect.fn("Archive.checkMount")(function* onArchiveHost(
  directory: string,
  runner: typeof Runner.Service
) {
  if (hostname() !== archiveHost) {
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
      "Protected archive requires both CIFS mounts. Restore the archive mounts before retrying export."
    );
  }

  return yield* Effect.void;
});

interface ArchiveRoots {
  readonly primary: string;
  readonly mirror: string;
}

export const archiveDiskLayer = (
  roots: ArchiveRoots,
  checkMount: (
    directory: string,
    runner: typeof Runner.Service
  ) => Effect.Effect<void, ArchiveFailure> = onArchiveHost
) =>
  Layer.effect(
    ArchivePort,
    Effect.gen(function* makeArchiveDisk() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* Runner;
      const destinations = [roots.primary, roots.mirror];

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

      const prepare = Effect.fn("Archive.prepare")(function* prepare() {
        if (
          destinations.some(
            (root) =>
              !path.isAbsolute(root) ||
              root === "/" ||
              path.normalize(root) !== root ||
              root.endsWith("/") ||
              /[\r\n]/u.test(root)
          ) ||
          destinations.some((root, index) =>
            destinations.some(
              (other, otherIndex) =>
                index !== otherIndex &&
                (root === other || other.startsWith(`${root}/`))
            )
          )
        ) {
          return yield* archiveFailure(
            "Archive roots must be disjoint absolute directories. Correct the primary and mirror configuration before retrying export."
          );
        }

        for (const root of destinations) {
          yield* verifyDirectory(root);
          yield* checkMount(root, runner);
        }

        return yield* Effect.void;
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

        if ((yield* fs.lstat(file)).type !== "File") {
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

        const manifest = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(ManifestSchema)
        )(yield* readText(directory, manifestName)).pipe(
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
          manifest.manifest_sha256 !== receipt.sha256 ||
          sha256(checksums) !== receipt.sha256 ||
          fingerprintOf(checksums, links, manifest.session_ids) !==
            receipt.fingerprint
        ) {
          return yield* archiveFailure(
            "Archive manifest differs from the source inventory. Inspect both custody copies and retry export."
          );
        }

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
          ]);
        }

        return manifest;
      });

      const put: typeof ArchivePort.Service.put = Effect.fn("Archive.diskPut")(
        function* put(manifest, files) {
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

          if (!files.paths.every(isArchivePath)) {
            return yield* archiveFailure(
              "Archive file is outside the permitted session roots. Inspect the stopped box before retrying export."
            );
          }

          yield* prepare();

          if (manifest.bytes > 50_000_000_000) {
            yield* Effect.logWarning(
              "Peon raw history exceeds 50 GB; exporting without a cap"
            );
          }

          for (const root of destinations) {
            const { final, incoming, parent } = layout(root, receipt);
            yield* fs.makeDirectory(parent, { mode: 0o700, recursive: true });
            yield* verifyDirectory(parent);

            if (yield* fs.exists(final)) {
              return yield* archiveFailure(
                "Archive final directory already exists. Export again with a fresh timestamp; existing archives are write-once."
              );
            }

            yield* fs.makeDirectory(incoming, { mode: 0o700 });

            if (files.paths.length !== 0) {
              yield* command(
                "rsync",
                [
                  "-rlt",
                  "--no-perms",
                  "--no-owner",
                  "--no-group",
                  "--files-from=-",
                  "--from0",
                  "--",
                  `${files.home}/`,
                  `${incoming}/`,
                ],
                `${files.paths.join("\0")}\0`
              );
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
            "Could not stage protected history in both archives. Check custody mounts and retry export with a fresh timestamp."
          )
        )
      );

      const checkCopies = Effect.fn("Archive.checkCopies")(
        function* checkCopies(
          dirs: readonly string[],
          receipt: ArchiveReceipt
        ) {
          const copies = [];

          for (const directory of dirs) {
            copies.push({
              directory,
              manifest: yield* check(directory, receipt),
            });
          }

          return copies;
        }
      );

      const checkReceipt = Effect.fn("Archive.checkReceipt")(
        function* checkReceipt(
          directory: string,
          manifest: Manifest,
          dirs: readonly string[],
          receipt: ArchiveReceipt
        ) {
          const proof = yield* Schema.decodeEffect(DiskReceipt)(
            yield* readText(directory, receiptName)
          ).pipe(
            Effect.mapError(() =>
              archiveFailure(
                "Protected archive receipt is missing or invalid. Retry export before destroying."
              )
            )
          );

          if (
            proof.manifest_sha256 !== receipt.sha256 ||
            proof.bytes !== manifest.bytes ||
            proof.files !== manifest.files ||
            JSON.stringify(proof.dirs) !== JSON.stringify(dirs) ||
            (manifest.session_ids.length === 0 && proof.sessions !== 0)
          ) {
            return yield* archiveFailure(
              "Protected archive receipt differs from the verified inventory. Retry export before destroying."
            );
          }

          return yield* Effect.void;
        }
      );

      const publishOrRestage = Effect.fn("Archive.publishOrRestage")(
        function* publishOrRestage(
          receipt: ArchiveReceipt,
          locations: readonly ReturnType<typeof layout>[]
        ) {
          const promoted: ReturnType<typeof layout>[] = [];
          const dirs = locations.map(({ final }) => final);

          return yield* Effect.gen(function* publishBoth() {
            for (const { incoming } of locations) {
              yield* check(incoming, receipt);
            }

            for (const location of locations) {
              yield* command("mv", [
                "-T",
                "-n",
                "--",
                location.incoming,
                location.final,
              ]).pipe(
                Effect.andThen(
                  Effect.gen(function* confirmPromotion() {
                    if (yield* fs.exists(location.incoming)) {
                      return yield* archiveFailure(
                        "Final archive already exists. Leave it untouched and retry export with a fresh timestamp."
                      );
                    }

                    promoted.push(location);

                    return yield* Effect.void;
                  })
                ),
                Effect.uninterruptible
              );
            }

            const copies = yield* checkCopies(dirs, receipt);

            const verifiedAt = DateTime.formatIso(yield* DateTime.now);

            for (const { directory, manifest } of copies) {
              const evidence = {
                bytes: manifest.bytes,
                checker_host: archiveHost,
                dirs,
                files: manifest.files,
                manifest_sha256: receipt.sha256,
                ok: true,
                rc: 0,
                verified_at: verifiedAt,
              };

              const proof =
                manifest.session_ids.length === 0
                  ? { ...evidence, sessions: 0 }
                  : evidence;

              yield* fs.writeFileString(
                path.join(directory, receiptName),
                JSON.stringify(proof),
                { flag: "wx", mode: 0o600 }
              );
            }

            for (const { directory, manifest } of copies) {
              yield* checkReceipt(directory, manifest, dirs, receipt);
            }

            return yield* Effect.void;
          }).pipe(
            Effect.onError(() =>
              Effect.forEach(
                promoted,
                ({ final, incoming }) =>
                  fs
                    .remove(path.join(final, receiptName), { force: true })
                    .pipe(
                      Effect.andThen(
                        command("mv", ["-T", "-n", "--", final, incoming])
                      ),
                      Effect.catch(() =>
                        Effect.logWarning(
                          "Could not return an incomplete peon archive to incoming. Inspect both custody roots before retrying."
                        )
                      )
                    ),
                { discard: true }
              )
            )
          );
        }
      );

      const readBack: typeof ArchivePort.Service.readBack = Effect.fn(
        "Archive.diskReadBack"
      )(
        function* readBack(
          receipt: ArchiveReceipt,
          purpose: "check" | "publish"
        ): Effect.fn.Return<
          ReadBack,
          ArchiveFailure | PlatformError.PlatformError
        > {
          yield* prepare();
          const locations = destinations.map((root) => layout(root, receipt));
          const dirs = locations.map(({ final }) => final);

          const exportReceipt = {
            id: archiveId(receipt),
            location: path.join(
              layout(roots.primary, receipt).final,
              receiptName
            ),
            mirror: path.join(layout(roots.mirror, receipt).final, receiptName),
            sha256: receipt.sha256,
          };

          if (purpose === "publish") {
            yield* publishOrRestage(receipt, locations);
          } else {
            const copies = yield* checkCopies(dirs, receipt);

            for (const { directory, manifest } of copies) {
              yield* checkReceipt(directory, manifest, dirs, receipt);
            }
          }

          return ReadBackResult.Verified({ exportReceipt });
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

      return ArchivePort.of({ put, readBack });
    })
  );
