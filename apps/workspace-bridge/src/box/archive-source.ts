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

export const sessionRoots = [
  primaryPiSession,
  piSessions,
  ".claude/projects",
  ".codex/sessions",
];

const safeName = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/u;

const derivedRoot = ".claude/projects";

const authoritative = (relative: string) =>
  !relative.startsWith(`${derivedRoot}/`);

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
  let header = Buffer.alloc(0);
  let complete = !pi;
  let bytes = 0;
  yield* fs.stream(file).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        digest.update(chunk);
        bytes += chunk.byteLength;

        if (!complete) {
          const newline = chunk.indexOf(10);
          const end = newline === -1 ? chunk.byteLength : newline;
          const remaining = 65_536 - header.length;
          header = Buffer.concat([
            header,
            chunk.subarray(0, Math.min(end, remaining)),
          ]);
          complete = newline !== -1 || header.length === 65_536;
        }
      })
    )
  );

  const session = pi
    ? Schema.decodeOption(PiHeader)(header.toString("utf-8"))
    : Option.none();

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
  function* collectArchive(
    home: string,
    box: BoxMetadata,
    identity: {
      readonly boxId: string;
      readonly host: string;
      readonly row?: string;
    }
  ) {
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
    const roots: Manifest["source_roots"][number][] = [];
    const unparsed: string[] = [];

    const visitRoot = Effect.fn("Archive.visitRoot")(function* visitRoot(
      root: string
    ) {
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

        return yield* Effect.void;
      }

      roots.push({
        path: root,
        role: root === derivedRoot ? "derived" : "authoritative",
      });
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

          if (
            Option.isSome(scanned.session) &&
            (root !== primaryPiSession || scanned.session.value.cwd === "/work")
          ) {
            sessions.add(scanned.session.value.id);
          } else if (pi) {
            unparsed.push(relative);
          } else if (jsonl) {
            const stem = path.basename(relative, ".jsonl");
            const id = uuid.exec(stem)?.[0];

            if (id === undefined) {
              unparsed.push(relative);
            } else {
              sessions.add(id);
            }
          }

          files.set(relative, { bytes: scanned.bytes, sha256: scanned.sha256 });

          return yield* Effect.void;
        })
      );

      return yield* Effect.void;
    });

    for (const root of sessionRoots) {
      const scan = visitRoot(root);
      yield* root === derivedRoot
        ? scan.pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "Some derived Claude transcript files could not be collected."
              )
            )
          )
        : scan;
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

    const manifestCore = {
      box_id: identity.boxId,
      bytes,
      created_at: DateTime.formatIso(yield* DateTime.now),
      exporter: "mischief-peon-boxes",
      exporter_version: "1",
      files: paths.length,
      manifest_sha256: sha256(checksums),
      peon_id: box.peonId,
      repo: box.template.workspace.repo,
      schema: "peon-archive.v1",
      session_ids: sessionIds,
      source_host: identity.host,
      source_roots: roots,
      unparsed: unparsed.toSorted(),
    } satisfies Manifest;

    const manifest =
      identity.row === undefined
        ? manifestCore
        : { ...manifestCore, row: identity.row };

    const authority = sha256(
      JSON.stringify([
        entries.filter(([name]) => authoritative(name)),
        [...symlinks]
          .filter(([name]) => authoritative(name))
          .toSorted(([a], [b]) => (a < b ? -1 : Number(a !== b))),
      ])
    );

    return {
      files: {
        authority,
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
