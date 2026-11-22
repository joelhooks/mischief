// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Digest has no incremental hash for streaming large raw histories.
import { createHash } from "node:crypto";

import {
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
  Schema,
  Stream,
} from "effect";
import type { PlatformError } from "effect";

import { archiveFailure } from "./archive-failure.js";
import type { ArchiveFailure } from "./archive-failure.js";
import type { Manifest } from "./archive.js";
import type { BoxMetadata } from "./protocol.js";

export const primaryPiSession = "session.jsonl";

const piAgentRoot = ".pi/agent";

const piSessions = `${piAgentRoot}/sessions`;

const sessionRoots = [
  primaryPiSession,
  piSessions,
  ".claude/projects",
  ".codex/sessions",
];

const safeName = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/u;

const uuid = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/iu;

export const isArchivePath = (file: string) =>
  file.split("/").every((name) => safeName.test(name)) &&
  (file === primaryPiSession ||
    sessionRoots.some(
      (root) => root !== primaryPiSession && file.startsWith(`${root}/`)
    ));

const PiHeader = Schema.fromJsonString(
  Schema.Struct({
    cwd: Schema.String.check(Schema.isPattern(/^\//u)),
    id: Schema.String.check(Schema.isUUID()),
    timestamp: Schema.DateTimeUtcFromString,
    type: Schema.Literal("session"),
    version: Schema.Literal(3),
  })
);

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export const fingerprintOf = (
  checksums: string,
  symlinks: string,
  sessionIds: readonly string[]
) => sha256(JSON.stringify([checksums, symlinks, sessionIds]));

export const walkArchive = Effect.fn("Archive.walk")(function* walkArchive<R>(
  root: string,
  relative: string,
  visit: (
    relative: string,
    stat: FileSystem.File.Info
  ) => Effect.Effect<void, ArchiveFailure | PlatformError.PlatformError, R>
): Effect.fn.Return<
  void,
  ArchiveFailure | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | R
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(root, relative);
  const stat = yield* fs.lstat(absolute);

  if (stat.type !== "Directory") {
    return yield* visit(relative, stat);
  }

  for (const name of yield* fs.readDirectory(absolute)) {
    if (!safeName.test(name)) {
      return yield* archiveFailure(
        "Archive contains a name outside [A-Za-z0-9._-]. Inspect the stopped box before retrying export."
      );
    }

    yield* walkArchive(root, path.join(relative, name), visit);
  }

  return yield* Effect.void;
});

const scanFile = Effect.fn("Archive.scanFile")(function* scanFile(
  file: string,
  pi: boolean
) {
  const fs = yield* FileSystem.FileSystem;
  const digest = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let first: string | undefined;
  let header = "";
  let bytes = 0;
  yield* fs.stream(file).pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* digestChunk() {
        digest.update(chunk);
        bytes += chunk.byteLength;

        if (pi && first === undefined) {
          const newline = chunk.indexOf(10);
          const head = newline === -1 ? chunk : chunk.subarray(0, newline);
          header += yield* Effect.try({
            try: () => decoder.decode(head, { stream: newline === -1 }),
            catch: () =>
              archiveFailure(
                "Pi session header is not UTF-8. Recover the raw session before retrying export."
              ),
          });

          if (header.length > 65_536) {
            return yield* archiveFailure(
              "Pi session has no bounded JSONL header. Recover the raw session before retrying export."
            );
          }

          if (newline !== -1) {
            first = header;
          }
        }

        return yield* Effect.void;
      })
    )
  );

  const session = pi
    ? yield* Schema.decodeEffect(PiHeader)(first ?? "").pipe(
        Effect.mapError(() =>
          archiveFailure(
            "Pi session is missing its v3 header, UUID, timestamp or absolute cwd. Recover the raw session before retrying export."
          )
        )
      )
    : undefined;

  return { bytes, session, sha256: digest.digest("hex") };
});

const sessionRootPresent = Effect.fn("Archive.sessionRootPresent")(
  function* sessionRootPresent(
    home: string,
    relative: string,
    expected: "Directory" | "File"
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const segments = relative.split("/");
    let current = home;

    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);

      const stat = yield* fs
        .lstat(current)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            Predicate.isTagged(error.reason, "NotFound")
              ? Effect.undefined
              : Effect.fail(error)
          )
        );

      if (stat === undefined) {
        return false;
      }

      const type = index === segments.length - 1 ? expected : "Directory";

      if (stat.type !== type) {
        return yield* archiveFailure(
          "Session root is not a canonical file or directory. Do not follow links; recover the stopped box's session roots before export."
        );
      }
    }

    return true;
  }
);

export const collectArchive = Effect.fn("Archive.collect")(
  function* collectArchive(home: string, box: BoxMetadata, host: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (
      (yield* fs.lstat(home)).type !== "Directory" ||
      (yield* fs.realPath(home)) !== home
    ) {
      return yield* archiveFailure(
        "Box home is not a canonical directory. Recover the stopped box's home before exporting."
      );
    }

    if (!(yield* sessionRootPresent(home, piAgentRoot, "Directory"))) {
      return yield* archiveFailure(
        "Box Pi agent directory is missing or not canonical. Recover it before retrying export."
      );
    }

    const files = new Map<
      string,
      { readonly bytes: number; readonly sha256: string }
    >();

    const symlinks = new Map<string, string>();
    const sessions = new Set<string>();
    const roots: string[] = [];

    for (const root of sessionRoots) {
      if (
        !(yield* sessionRootPresent(
          home,
          root,
          root === primaryPiSession ? "File" : "Directory"
        ))
      ) {
        if (root === primaryPiSession && box.lastPromptAt !== null) {
          return yield* archiveFailure(
            "Prompted box is missing its managed Pi session. Recover home/session.jsonl before exporting or destroying."
          );
        }

        continue;
      }

      roots.push(root);
      yield* walkArchive(home, root, (relative, entry) =>
        Effect.gen(function* visitSession() {
          const file = path.join(home, relative);

          if (entry.type === "SymbolicLink") {
            const target = yield* fs.readLink(file);

            if (/[\t\r\n]/u.test(target)) {
              return yield* archiveFailure(
                "Session symlink cannot be represented by SYMLINKS.tsv. Inspect the stopped box before retrying export."
              );
            }

            symlinks.set(relative, target);

            return yield* Effect.void;
          }

          if (
            entry.type !== "File" ||
            Option.getOrElse(entry.nlink, () => 0n) !== 1n
          ) {
            return yield* archiveFailure(
              "Session tree contains a special file or hard link. Inspect the stopped box before retrying export."
            );
          }

          const jsonl = relative.endsWith(".jsonl");

          const pi =
            root === primaryPiSession || (root === piSessions && jsonl);

          const scanned = yield* scanFile(file, pi);

          if (scanned.session !== undefined) {
            if (root === primaryPiSession && scanned.session.cwd !== "/work") {
              return yield* archiveFailure(
                "Managed Pi session header cwd is not /work. Recover the correct session before exporting."
              );
            }

            sessions.add(scanned.session.id);
          } else if (jsonl) {
            const stem = path.basename(relative, ".jsonl");
            sessions.add(uuid.exec(stem)?.[0] ?? stem);
          }

          files.set(relative, scanned);

          return yield* Effect.void;
        })
      );
    }

    const entries = [...files.entries()].toSorted(([a], [b]) =>
      a < b ? -1 : Number(a !== b)
    );

    const paths = entries.map(([name]) => name);
    const bytes = entries.reduce((total, [, file]) => total + file.bytes, 0);

    const checksums = entries
      .map(([name, file]) => `${file.sha256}  ${name}\n`)
      .join("");

    const links = [...symlinks.keys()]
      .toSorted()
      .map((name) => `${name}\t${symlinks.get(name)}\n`)
      .join("");

    const sessionIds = [...sessions].toSorted();

    const manifest: Manifest = {
      box_id: box.peonId,
      bytes,
      created_at: DateTime.formatIso(yield* DateTime.now),
      exporter: "mischief-peon-boxes",
      exporter_version: "1",
      files: paths.length,
      manifest_sha256: sha256(checksums),
      peon_id: box.peonId,
      repo: box.template.workspace.repo,
      row: box.peonId,
      schema: "peon-archive.v1",
      session_ids: sessionIds,
      source_host: host,
      source_roots: roots,
    };

    return {
      files: {
        checksums,
        fingerprint: fingerprintOf(checksums, links, sessionIds),
        home,
        paths,
        symlinks: links,
      },
      manifest,
    };
  },
  Effect.catchTag("PlatformError", () =>
    archiveFailure(
      "Could not read stopped box history. Recover its home and session roots before retrying export."
    )
  )
);
