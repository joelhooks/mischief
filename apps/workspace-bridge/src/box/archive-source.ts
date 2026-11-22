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

const snapshotPrefix = "snapshot/";

export const isArchivePath = (file: string) => {
  const relative = file.startsWith(snapshotPrefix)
    ? file.slice(snapshotPrefix.length)
    : file;

  return (
    relative.split("/").every((name) => safeName.test(name)) &&
    sessionRoots.some((root) => belongs(relative, root))
  );
};

const escapeName = (name: string) =>
  safeName.test(name) && !name.startsWith("__escaped__")
    ? name
    : `__escaped__${sha256(name)}`;

const escapePath = (name: string) => name.split("/").map(escapeName).join("/");

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
  sessionIds: readonly string[],
  renamed: NonNullable<Manifest["renamed"]> = [],
  nonData: NonNullable<Manifest["nonData"]> = []
) =>
  sha256(JSON.stringify([checksums, symlinks, sessionIds, renamed, nonData]));

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
      yield* walkArchive(root, path.join(relative, name), visit, skip);
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
  readHeader: boolean,
  claude: boolean
) {
  const fs = yield* FileSystem.FileSystem;
  const digest = createHash("sha256");
  let remaining = claude ? 8 * 1024 * 1024 : 65_536;
  const segments: Uint8Array[] = [];
  let complete = !readHeader;
  let bytes = 0;
  let found = Option.none<string>();

  const decodeClaude = () =>
    Schema.decodeOption(ClaudeHeader)(
      Buffer.concat(segments).toString("utf-8")
    ).pipe(Option.map(({ sessionId }) => sessionId));

  yield* fs.stream(file).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        digest.update(chunk);
        bytes += chunk.byteLength;

        for (let offset = 0; !complete && offset < chunk.byteLength;) {
          const newline = chunk.indexOf(10, offset);
          const hasRecord = newline !== -1 && newline - offset < remaining;

          const end = hasRecord
            ? newline
            : Math.min(chunk.byteLength, offset + remaining);

          segments.push(chunk.subarray(offset, end));
          remaining -= end - offset + Number(hasRecord);

          if (claude && hasRecord) {
            found = decodeClaude();
            segments.length = 0;
          }

          complete =
            (hasRecord && !claude) || remaining === 0 || Option.isSome(found);
          offset = end + Number(hasRecord);
        }
      })
    )
  );

  return {
    bytes,
    header: claude ? "" : Buffer.concat(segments).toString("utf-8"),
    claudeId: claude && !complete ? decodeClaude() : found,
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
    },
    snapshot?: string
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const files = new Map<
      string,
      { readonly bytes: number; readonly sha256: string }
    >();

    const sources = new Map<string, string>();
    const nonData: { path: string; type: string }[] = [];
    const renamed: { from: string; to: string }[] = [];
    const symlinks = new Map<string, string>();
    const sessions = new Set<string>();
    const roots: Manifest["source_roots"][number][] = [];
    const unparsed: string[] = [];
    const skipped: Manifest["skipped"][number][] = [];

    const recordSkip = (entry: Manifest["skipped"][number]) => {
      skipped.push(entry);
    };

    const visitRoot = Effect.fn("Archive.visitRoot")(function* visitRoot(
      source: string,
      prefix: string,
      root: string
    ) {
      if (
        !(yield* sessionRootPresent(
          source,
          root,
          singleFiles.has(root) ? "File" : "Directory"
        ))
      ) {
        return yield* Effect.void;
      }

      roots.push({
        path: prefix + root,
        role: derivedRoots.has(root) ? "derived" : "authoritative",
      });
      yield* walkArchive(
        source,
        root,
        (relative, entry) =>
          Effect.gen(function* visitSession() {
            const file = path.join(source, relative);
            const from = prefix + relative;
            const name = prefix + escapePath(relative);

            if (entry.type === "SymbolicLink") {
              const target = yield* fs.readLink(file);

              symlinks.set(
                name,
                /[\t\r\n]/u.test(target) || target.startsWith('"')
                  ? JSON.stringify(target)
                  : target
              );

              return yield* Effect.void;
            }

            if (entry.type !== "File") {
              nonData.push({ path: name, type: entry.type });

              return yield* Effect.void;
            }

            const jsonl = relative.endsWith(".jsonl");

            const pi =
              root === primaryPiSession || (root === piSessions && jsonl);

            const transcript = jsonl && relative !== codexHistory;
            const claude = derivedRoots.has(root);

            const scanned = yield* scanFile(
              file,
              transcript,
              claude && transcript
            );

            if (transcript) {
              const id = claude
                ? scanned.claudeId
                : sessionId(root, scanned.header, pi);

              if (Option.isSome(id)) {
                sessions.add(id.value);
              } else {
                unparsed.push(name);
              }
            }

            if (from !== name) {
              renamed.push({ from, to: name });
            }

            sources.set(name, file);
            files.set(name, {
              bytes: scanned.bytes,
              sha256: scanned.sha256,
            });

            return yield* Effect.void;
          }),
        derivedRoots.has(root)
          ? (entry) => {
              recordSkip({ ...entry, path: prefix + entry.path });
            }
          : undefined
      );

      return yield* Effect.void;
    });

    const trees =
      snapshot === undefined
        ? [{ source: home, prefix: "" }]
        : [
            { source: home, prefix: "" },
            { source: snapshot, prefix: snapshotPrefix },
          ];

    for (const { source, prefix } of trees) {
      if (
        (yield* fs.lstat(source)).type !== "Directory" ||
        (yield* fs.realPath(source)) !== source
      ) {
        return yield* archiveFailure(
          "Box home is not a canonical directory. Recover the stopped box's home before exporting."
        );
      }

      if (!(yield* sessionRootPresent(source, piAgentRoot, "Directory"))) {
        return yield* archiveFailure(
          "Box Pi agent directory is missing or not canonical. Recover it before retrying export."
        );
      }

      for (const root of sessionRoots) {
        const scan = visitRoot(source, prefix, root);
        yield* derivedRoots.has(root)
          ? scan.pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  recordSkip({
                    path: prefix + root,
                    reason: Predicate.isTagged(error, "ArchiveFailure")
                      ? error.message
                      : "Session root could not be read.",
                  });
                })
              )
            )
          : scan;
      }
    }

    if (
      box.lastPromptAt !== null &&
      !sources.has(primaryPiSession) &&
      !sources.has(snapshotPrefix + primaryPiSession)
    ) {
      return yield* archiveFailure(
        "Prompted box is missing its managed Pi session. Recover home/session.jsonl before exporting or destroying."
      );
    }

    renamed.sort((a, b) => (a.from < b.from ? -1 : Number(a.from !== b.from)));
    nonData.sort((a, b) => (a.path < b.path ? -1 : Number(a.path !== b.path)));
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
      renamed,
      nonData,
    } satisfies Manifest;

    const manifest =
      identity.row === undefined
        ? manifestCore
        : { ...manifestCore, row: identity.row };

    return {
      files: {
        checksums,
        fingerprint: fingerprintOf(
          checksums,
          links,
          sessionIds,
          renamed,
          nonData
        ),
        sources,
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
