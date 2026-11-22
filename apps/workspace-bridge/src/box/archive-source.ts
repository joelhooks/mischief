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

export const agentDirs = {
  PI_CODING_AGENT_DIR: ".pi/agent",
  CLAUDE_CONFIG_DIR: ".claude",
  CODEX_HOME: ".codex",
};

const piAgentRoot = agentDirs.PI_CODING_AGENT_DIR;

const piSessions = `${piAgentRoot}/sessions`;

const claudeProjects = `${agentDirs.CLAUDE_CONFIG_DIR}/projects`;

const bridge = `${piAgentRoot}/claude-bridge`;

const codexHistory = `${agentDirs.CODEX_HOME}/history.jsonl`;

const derivedRoots = new Set([bridge, claudeProjects]);

const singleFiles = new Set([primaryPiSession, codexHistory]);

export const sessionRoots = [
  primaryPiSession,
  piSessions,
  bridge,
  claudeProjects,
  `${agentDirs.CODEX_HOME}/sessions`,
  `${agentDirs.CODEX_HOME}/archived_sessions`,
  codexHistory,
];

const safeName = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/u;

const belongs = (relative: string, root: string) =>
  singleFiles.has(root) ? relative === root : relative.startsWith(`${root}/`);

const SessionId = Schema.String.check(Schema.isUUID());

const ClaudeHeader = Schema.fromJsonString(
  Schema.Struct({ sessionId: SessionId })
);

const CodexHeader = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("session_meta"),
    payload: Schema.Struct({ id: SessionId }),
  })
);

export const isArchivePath = (file: string) =>
  file.split("/").every((name) => safeName.test(name)) &&
  sessionRoots.some((root) => belongs(file, root));

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
  ) => Effect.Effect<void, ArchiveFailure | PlatformError.PlatformError, R>,
  skip?: (entry: { path: string; reason: string }) => void
): Effect.fn.Return<
  void,
  ArchiveFailure | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | R
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(root, relative);

  const scan = Effect.gen(function* scanEntry() {
    const stat = yield* fs.lstat(absolute);

    if (stat.type !== "Directory") {
      return yield* visit(relative, stat);
    }

    for (const name of yield* fs.readDirectory(absolute)) {
      const child = path.join(relative, name);

      if (safeName.test(name)) {
        yield* walkArchive(root, child, visit, skip);
      } else {
        const reason =
          "Archive contains a name outside [A-Za-z0-9._-]. Inspect the stopped box before retrying export.";

        if (skip === undefined) {
          return yield* archiveFailure(reason);
        }

        skip({ path: child, reason });
      }
    }

    return yield* Effect.void;
  });

  return yield* skip === undefined
    ? scan
    : scan.pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            skip({
              path: relative,
              reason: Predicate.isTagged(error, "ArchiveFailure")
                ? error.message
                : "Session path could not be read.",
            });
          })
        )
      );
});

const scanFile = Effect.fn("Archive.scanFile")(function* scanFile(
  file: string,
  readHeader: boolean
) {
  const fs = yield* FileSystem.FileSystem;
  const digest = createHash("sha256");
  let header = Buffer.alloc(0);
  let complete = !readHeader;
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

  return {
    bytes,
    header: header.toString("utf-8"),
    sha256: digest.digest("hex"),
  };
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

const sessionId = (root: string, head: string, pi: boolean) => {
  if (pi) {
    return Schema.decodeOption(PiHeader)(head).pipe(
      Option.filter(({ cwd }) => root !== primaryPiSession || cwd === "/work"),
      Option.map(({ id }) => id)
    );
  }

  if (derivedRoots.has(root)) {
    return Schema.decodeOption(ClaudeHeader)(head).pipe(
      Option.map(({ sessionId: id }) => id)
    );
  }

  return Schema.decodeOption(CodexHeader)(head).pipe(
    Option.map(({ payload }) => payload.id)
  );
};

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
    const skipped: Manifest["skipped"][number][] = [];

    const recordSkip = (entry: Manifest["skipped"][number]) => {
      skipped.push(entry);
    };

    const visitRoot = Effect.fn("Archive.visitRoot")(function* visitRoot(
      root: string
    ) {
      if (
        !(yield* sessionRootPresent(
          home,
          root,
          singleFiles.has(root) ? "File" : "Directory"
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
        role: derivedRoots.has(root) ? "derived" : "authoritative",
      });
      yield* walkArchive(
        home,
        root,
        (relative, entry) =>
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

            const transcript = jsonl && relative !== codexHistory;
            const scanned = yield* scanFile(file, transcript);

            if (transcript) {
              const id = sessionId(root, scanned.header, pi);

              if (Option.isSome(id)) {
                sessions.add(id.value);
              } else {
                unparsed.push(relative);
              }
            }

            files.set(relative, {
              bytes: scanned.bytes,
              sha256: scanned.sha256,
            });

            return yield* Effect.void;
          }),
        derivedRoots.has(root) ? recordSkip : undefined
      );

      return yield* Effect.void;
    });

    for (const root of sessionRoots) {
      const scan = visitRoot(root);
      yield* derivedRoots.has(root)
        ? scan.pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                recordSkip({
                  path: root,
                  reason: Predicate.isTagged(error, "ArchiveFailure")
                    ? error.message
                    : "Session root could not be read.",
                });
              })
            )
          )
        : scan;
    }

    skipped.sort((a, b) => (a.path < b.path ? -1 : Number(a.path !== b.path)));

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
      skipped,
    } satisfies Manifest;

    const manifest =
      identity.row === undefined
        ? manifestCore
        : { ...manifestCore, row: identity.row };

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
