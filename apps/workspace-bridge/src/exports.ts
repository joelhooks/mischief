import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import type { PlatformError, Scope } from "effect";

import { Sha, refusal } from "./protocol.js";
import type { Workspace } from "./protocol.js";
import { checked, Runner } from "./runner.js";
import type { Command } from "./runner.js";

export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

export const DISK_BUDGET = 50_000_000_000;

export interface ExportConfig {
  readonly root: string;
  readonly repos: Readonly<Record<string, string>>;
}

const Metadata = Schema.Struct({
  digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  used: Schema.Finite,
});

export interface Checkout {
  readonly digest: string;
  readonly path: string;
}

export const safePath = Effect.fn("WorkspaceExports.safePath")(
  function* safePath(target: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (!path.isAbsolute(target) || path.normalize(target) !== target) {
      return yield* refusal(
        "The export path is not canonical. Configure an absolute, normalized MISCHIEF_WORKSPACE_EXPORTS_ROOT without symlinks."
      );
    }

    let current = target;

    while (true) {
      if ((yield* fs.realPath(current)) !== current) {
        return yield* refusal(
          "The export path contains a symlink. Remove the symlink and rebuild the export under MISCHIEF_WORKSPACE_EXPORTS_ROOT."
        );
      }

      const parent = path.dirname(current);

      if (parent === current) {
        break;
      }

      current = parent;
    }

    return target;
  }
);

export class Exports extends Context.Service<
  Exports,
  {
    readonly checkout: (
      workspace: Workspace
    ) => Effect.Effect<Checkout, BridgeFailure, Scope.Scope>;
    readonly gc: Effect.Effect<void, BridgeFailure>;
  }
>()("@mischief/workspace-bridge/Exports") {
  static readonly layer = (config: ExportConfig) =>
    Layer.effect(
      Exports,
      Effect.gen(function* makeExports() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* Runner;

        const execute = (command: Command) =>
          checked(command).pipe(Effect.provideService(Runner, runner));

        const safe = (target: string) =>
          safePath(target).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path)
          );

        const lock = yield* Semaphore.make(1);
        const leases = yield* Ref.make(new Map<string, number>());
        const root = path.resolve(config.root);
        const mirrors = path.join(root, "mirrors");
        const exports = path.join(root, "exports");
        const metadata = path.join(root, "metadata");
        yield* fs.makeDirectory(root, { mode: 0o700, recursive: true });
        yield* safe(root);

        for (const directory of [mirrors, exports, metadata]) {
          yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
          yield* safe(directory);
        }

        const tree = Effect.fn("WorkspaceExports.tree")(function* tree(
          directory: string,
          readonly: boolean
        ): Effect.fn.Return<void, BridgeFailure | PlatformError.PlatformError> {
          yield* safe(directory);

          for (const name of yield* fs.readDirectory(directory)) {
            const entry = path.join(directory, name);
            yield* safe(entry);
            const info = yield* fs.stat(entry);

            if (info.type === "Directory") {
              yield* tree(entry, readonly);
            } else if (info.type === "File") {
              if (readonly) {
                yield* fs.chmod(
                  entry,
                  [1, 8, 64].some(
                    (divisor) => Math.floor(info.mode / divisor) % 2 === 1
                  )
                    ? 0o555
                    : 0o444
                );
              }
            } else {
              return yield* refusal(
                "An export contains a symlink or special file. Use a commit with only regular files and directories, then retry."
              );
            }
          }

          if (readonly) {
            yield* fs.chmod(directory, 0o555);
          }

          return undefined;
        });

        const capacity = Effect.fn("WorkspaceExports.capacity")(
          function* capacity() {
            const output = yield* execute({
              args: ["-sb", root],
              executable: "du",
            });

            const size = Number(output.split("\t")[0]);

            if (!Number.isSafeInteger(size) || size < 0 || size > DISK_BUDGET) {
              return yield* refusal(
                "Workspace mirrors and exports reached the 50 GB budget. Run workspace export GC and inspect mirror usage before retrying.",
                503
              );
            }

            return yield* Effect.void;
          }
        );

        const gc = lock
          .withPermits(1)(
            Effect.gen(function* collectExports() {
              const now = yield* Clock.currentTimeMillis;
              const active = yield* Ref.get(leases);

              for (const sha of yield* fs.readDirectory(exports)) {
                if (!Schema.is(Sha)(sha) || (active.get(sha) ?? 0) > 0) {
                  continue;
                }

                const target = path.join(exports, sha);
                const metaPath = path.join(metadata, `${sha}.json`);
                yield* safe(target);

                let used: number;

                if (yield* fs.exists(metaPath)) {
                  yield* safe(metaPath);

                  const meta = yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(Metadata)
                  )(yield* fs.readFileString(metaPath));

                  ({ used } = meta);
                } else {
                  used = Option.match((yield* fs.stat(target)).mtime, {
                    onNone: () => now,
                    onSome: (time) => time.getTime(),
                  });
                }

                if (now - used >= EXPORT_TTL_MS) {
                  yield* tree(target, false);
                  yield* execute({
                    args: ["-R", "u+w", target],
                    executable: "chmod",
                  });
                  yield* fs.remove(target, { recursive: true });
                  yield* fs.remove(metaPath, { force: true });
                }
              }

              for (const name of yield* fs.readDirectory(root)) {
                if (!/^(?:export|mirror|metadata)-[a-zA-Z0-9]+$/u.test(name)) {
                  continue;
                }

                const temporary = path.join(root, name);
                yield* safe(temporary);

                const used = Option.match((yield* fs.stat(temporary)).mtime, {
                  onNone: () => now,
                  onSome: (time) => time.getTime(),
                });

                if (now - used >= EXPORT_TTL_MS) {
                  yield* tree(temporary, false);
                  yield* execute({
                    args: ["-R", "u+w", temporary],
                    executable: "chmod",
                  });
                  yield* fs.remove(temporary, { recursive: true });
                }
              }

              yield* capacity();
            })
          )
          .pipe(
            Effect.mapError(() =>
              refusal(
                "Workspace export GC could not safely inspect the cache. Check canonical paths, metadata and the 50 GB disk budget, then retry.",
                503
              )
            )
          );

        const checkout = Effect.fn("WorkspaceExports.checkout")(
          function* checkout(workspace: Workspace) {
            if (!Schema.is(Sha)(workspace.sha)) {
              return yield* refusal(
                "Invalid workspace sha. Send exactly 40 lowercase hex characters, not a branch or short sha."
              );
            }

            const remote = Object.hasOwn(config.repos, workspace.repo)
              ? config.repos[workspace.repo]
              : undefined;

            if (remote === undefined) {
              return yield* refusal(
                "Workspace repo is not allowlisted. Ask the host owner to add its read-only walgit mirror to MISCHIEF_WORKSPACE_MIRRORS, then retry.",
                403
              );
            }

            yield* gc;
            const { sha } = workspace;
            const target = path.join(exports, sha);
            const metaPath = path.join(metadata, `${sha}.json`);

            return yield* lock.withPermits(1)(
              Effect.gen(function* prepareExport() {
                yield* safe(root);
                yield* safe(exports);
                yield* safe(metadata);
                yield* safe(mirrors);

                const mirror = path.join(
                  mirrors,
                  encodeURIComponent(workspace.repo)
                );

                if (!(yield* fs.exists(mirror))) {
                  const temporary = yield* fs.makeTempDirectoryScoped({
                    directory: root,
                    prefix: "mirror-",
                  });

                  const cloned = path.join(temporary, "mirror");
                  yield* execute({
                    args: ["clone", "--mirror", "--", remote, cloned],
                    executable: "git",
                  });
                  yield* fs.rename(cloned, mirror);
                }

                yield* safe(mirror);
                yield* execute({
                  args: ["--git-dir", mirror, "fetch", "--prune", "origin"],
                  executable: "git",
                });
                yield* capacity();
                yield* execute({
                  args: [
                    "--git-dir",
                    mirror,
                    "cat-file",
                    "-e",
                    `${sha}^{commit}`,
                  ],
                  executable: "git",
                });
                let digest: string;
                let publication: string | undefined;

                if (yield* fs.exists(target)) {
                  yield* tree(target, true);
                  yield* safe(metaPath);

                  const meta = yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(Metadata)
                  )(yield* fs.readFileString(metaPath));

                  ({ digest } = meta);
                } else {
                  const listing = yield* execute({
                    args: [
                      "--git-dir",
                      mirror,
                      "ls-tree",
                      "-rz",
                      "--full-tree",
                      sha,
                    ],
                    executable: "git",
                  });

                  if (
                    listing
                      .split("\0")
                      .some(
                        (entry) =>
                          entry.startsWith("120000 ") ||
                          entry.startsWith("160000 ")
                      )
                  ) {
                    return yield* refusal(
                      "This commit contains symlinks or submodules. Select a commit containing only regular files and directories, then retry.",
                      400
                    );
                  }

                  const temporary = yield* fs.makeTempDirectoryScoped({
                    directory: root,
                    prefix: "export-",
                  });

                  yield* Effect.addFinalizer(() =>
                    execute({
                      args: ["-R", "u+w", temporary],
                      executable: "chmod",
                    }).pipe(Effect.orDie)
                  );
                  const archive = path.join(temporary, "tree.tar");
                  const unpacked = path.join(temporary, "tree");
                  yield* fs.makeDirectory(unpacked);
                  yield* execute({
                    args: [
                      "--git-dir",
                      mirror,
                      "archive",
                      "--format=tar",
                      `--output=${archive}`,
                      sha,
                    ],
                    executable: "git",
                  });
                  yield* capacity();

                  const sum = yield* execute({
                    args: [archive],
                    executable: "sha256sum",
                  });

                  digest = yield* Schema.decodeUnknownEffect(
                    Metadata.fields.digest
                  )(sum.slice(0, 64));
                  yield* execute({
                    args: [
                      "--extract",
                      "--file",
                      archive,
                      "--directory",
                      unpacked,
                      "--no-same-owner",
                      "--no-same-permissions",
                    ],
                    executable: "tar",
                  });
                  yield* capacity();
                  yield* tree(unpacked, true);
                  yield* fs.chmod(unpacked, 0o755);
                  publication = unpacked;
                }

                if (
                  Option.isSome(
                    yield* fs.readLink(metaPath).pipe(Effect.option)
                  )
                ) {
                  return yield* refusal(
                    "Workspace metadata is a symlink. Remove that link and rebuild the pinned export before retrying."
                  );
                }

                const metadataStage = yield* fs.makeTempDirectoryScoped({
                  directory: root,
                  prefix: "metadata-",
                });

                const metadataSource = path.join(metadataStage, "value.json");

                const metadataFile = yield* fs.open(metadataSource, {
                  flag: "wx",
                  mode: 0o600,
                  noFollow: true,
                });

                yield* metadataFile.writeAll(
                  new TextEncoder().encode(
                    JSON.stringify({
                      digest,
                      used: yield* Clock.currentTimeMillis,
                    })
                  )
                );
                yield* metadataFile.sync;
                yield* fs.rename(metadataSource, metaPath);

                if (publication !== undefined) {
                  yield* fs.rename(publication, target);
                  yield* fs.chmod(target, 0o555);
                }

                yield* Effect.acquireRelease(
                  Ref.update(leases, (counts) =>
                    new Map(counts).set(sha, (counts.get(sha) ?? 0) + 1)
                  ),
                  () =>
                    Ref.update(leases, (counts) =>
                      new Map(counts).set(
                        sha,
                        Math.max(0, (counts.get(sha) ?? 1) - 1)
                      )
                    )
                );

                return { digest, path: target };
              })
            );
          },
          Effect.mapError((failure) =>
            Schema.is(BridgeFailure)(failure)
              ? failure
              : refusal(
                  `Workspace export preparation failed (${failure._tag}). Check the read-only walgit mirror, pinned commit and canonical cache paths, then retry.`,
                  400
                )
          )
        );

        yield* gc;

        return Exports.of({ checkout, gc });
      })
    );
}
