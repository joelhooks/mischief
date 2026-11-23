// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect FileSystem does not offer O_NOFOLLOW or O_NONBLOCK for opening untrusted box files.
import { constants } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Descriptor-relative Linux reads must pin the box and home directories without following symlinks.
import { open } from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The pinned descriptors come from Node's flag-aware open API.
import type { FileHandle } from "node:fs/promises";

import { peonTailDefaultEntries } from "@mischief/core";
import type {
  BoxTailResult,
  PeonTailEntryType,
  PeonTailQuery,
} from "@mischief/core";
import { Effect, Option, Schema } from "effect";

import { refusal } from "../protocol.js";
import { primaryPiSession } from "./archive-source.js";

const scanBytes = 1024 * 1024;

const inspectLineBytes = 2048;

const lineFeed = 10;

const RecordHeader = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    message: Schema.optionalKey(
      Schema.Struct({
        role: Schema.Literals(["assistant", "system", "toolResult", "user"]),
      })
    ),
  })
);

const IoError = Schema.Struct({ code: Schema.String });

const ioFailure = (error: Option.Option<typeof IoError.Type>) =>
  Option.exists(error, ({ code }) => code === "ENOENT")
    ? ("no-session" as const)
    : refusal(
        "Managed Pi session could not be read safely. Check the box home before retrying tailPeon.",
        503
      );

const recordType = (line: Buffer): typeof PeonTailEntryType.Type => {
  if (line.length > inspectLineBytes) {
    return "blob";
  }

  const header = Schema.decodeOption(RecordHeader)(line.toString("utf-8"));

  if (Option.isNone(header)) {
    return "other";
  }

  const { type, message } = header.value;

  if (type === "session" || type === "compaction") {
    return type;
  }

  return type === "message" ? (message?.role ?? "other") : "other";
};

type TailPage = Extract<typeof BoxTailResult.Type, { status: "tail" }>;

const summarize = (
  buffer: Buffer,
  start: number,
  query: typeof PeonTailQuery.Type
): TailPage => {
  const entries: TailPage["entries"][number][] = [];
  const first = start === 0 ? 0 : buffer.indexOf(lineFeed) + 1;

  const since =
    query.sinceId === undefined ? 0 : Number(query.sinceId.slice(1));

  const limit = query.entries ?? peonTailDefaultEntries;
  let end = buffer.lastIndexOf(lineFeed);

  if (start > 0 && first === 0) {
    return {
      entries,
      status: "tail",
      truncated: start + buffer.length > since,
    };
  }

  while (end >= first && start + end + 1 > since && entries.length < limit) {
    const begin = end === 0 ? 0 : buffer.lastIndexOf(lineFeed, end - 1) + 1;

    if (end > begin) {
      entries.push({
        bytes: end - begin,
        id: `b${start + end + 1}`,
        type: recordType(buffer.subarray(begin, end)),
      });
    }

    end = begin - 1;
  }

  return {
    entries: entries.toReversed(),
    status: "tail",
    truncated: start + Math.max(first, end + 1) > since,
  };
};

const sessionIo = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    // oxlint-disable-next-line typescript/promise-function-async -- Do not pass Effect's AbortSignal as an argument to bound Node I/O methods.
    try: () => operation(),
    catch: (error) => ioFailure(Schema.decodeUnknownOption(IoError)(error)),
  });

const opened = (path: string, flags: number) =>
  Effect.acquireRelease(
    sessionIo(open.bind(undefined, path, flags)),
    (handle) => sessionIo(handle.close.bind(handle)).pipe(Effect.ignore)
  );

const directoryFlags =
  // oxlint-disable-next-line eslint/no-bitwise -- Node open accepts an OR mask of independent POSIX flags.
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

const fileFlags =
  // oxlint-disable-next-line eslint/no-bitwise -- Do not follow links or let a FIFO block the manager.
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const anchoredAt = (directory: FileHandle, name: string) =>
  `/proc/self/fd/${directory.fd}/${name}`;

export const readSessionTail = (
  boxDirectory: string,
  query: typeof PeonTailQuery.Type
) =>
  Effect.gen(function* readTail() {
    const box = yield* opened(boxDirectory, directoryFlags);
    const home = yield* opened(anchoredAt(box, "home"), directoryFlags);

    const session = yield* opened(
      anchoredAt(home, primaryPiSession),
      fileFlags
    );

    const stat = yield* sessionIo(session.stat.bind(session));

    if (stat?.isFile() !== true || !Schema.is(Schema.Natural)(stat.size)) {
      return yield* refusal(
        "Managed Pi session is not a regular file. Check the box home before retrying tailPeon.",
        503
      );
    }

    const start = Math.max(0, stat.size - scanBytes);
    const buffer = Buffer.alloc(stat.size - start);

    const { bytesRead } = yield* sessionIo(
      session.read.bind(session, { buffer, position: start })
    );

    if (bytesRead !== buffer.length) {
      return yield* refusal(
        "Managed Pi session changed during the read. Retry tailPeon.",
        503
      );
    }

    return summarize(buffer, start, query);
  }).pipe(
    Effect.scoped,
    Effect.catchIf(
      (error) => error === "no-session",
      (reason) =>
        Effect.succeed<typeof BoxTailResult.Type>({
          reason,
          status: "not-live",
        })
    )
  );
