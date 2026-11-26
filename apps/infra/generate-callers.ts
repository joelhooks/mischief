import { isDeepStrictEqual } from "node:util";

import { callerName } from "@mischief/core";
import { Document } from "@rat-king/mailbox-client/auth";
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect";

import {
  CallerGenerationRefused,
  readCallerDirectory,
  refuseCallers,
} from "./caller-directory.ts";
import { decodeCallers } from "./callers.ts";

const FLEET_SUFFIX = ".pi.ratking-fleet.invalid";

const RESERVED_FLEET_SUFFIX = ".ratking-fleet.invalid";

const PROBE_OR_CANARY = /(?:^|[/_-])(?:probe|canary)(?:$|[/_-])/iu;

const PI_SESSION =
  /(?:^|\/)pi-(?:[0-9a-hjkmnp-tv-z]{26}|[0-9a-f]{8,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{5,12})$/iu;

type SkipGeneratedName = (name: string) => boolean;

const countEphemeralNames = () => {
  const counts = { probeOrCanary: 0, session: 0 };

  const skip = (name: string) => {
    if (PROBE_OR_CANARY.test(name)) {
      counts.probeOrCanary += 1;

      return true;
    }

    if (PI_SESSION.test(name)) {
      counts.session += 1;

      return true;
    }

    return false;
  };

  const warning = () =>
    counts.probeOrCanary + counts.session === 0
      ? []
      : [
          `Skipped ephemeral caller entries: probe/canary=${counts.probeOrCanary}, session=${counts.session}`,
        ];

  return { skip, warning };
};

const skipReservedDid = (did: string, skip: SkipGeneratedName) => {
  const prefix = "did:web:";
  const templated = did.endsWith(FLEET_SUFFIX);
  const suffix = templated ? FLEET_SUFFIX : RESERVED_FLEET_SUFFIX;

  if (!did.startsWith(prefix) || !did.endsWith(suffix)) {
    return false;
  }

  const label = did.slice(prefix.length, -suffix.length);

  const encodedName = templated
    ? /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)?$/iu
    : /^[a-z0-9_-]+$/iu;

  return encodedName.test(label) && skip(label.replace(".", "/"));
};

const matchesFleetName = (did: string, name: string) =>
  did === `did:web:${name.replace("/", ".")}${FLEET_SUFFIX}` &&
  Option.getOrUndefined(callerName(did)) === name;

const matchesReservedName = (did: string, name: string) =>
  matchesFleetName(did, name) ||
  (!name.includes("/") && did === `did:web:${name}${RESERVED_FLEET_SUFFIX}`);

const DocumentId = Schema.Struct({ id: Schema.String });

const RawDocuments = Schema.fromJsonString(Schema.Array(Schema.Json));

const ExtraDocuments = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, document: Schema.Json }))
);

interface CallerDocumentFiles {
  readonly reserved: string;
  readonly extras: string;
}

interface Candidate {
  readonly did: string;
  readonly document?: Schema.Json;
  readonly name: string;
}

const documentDid = (document: Schema.Json, source: "reserved" | "extras") =>
  Schema.decodeUnknownEffect(DocumentId)(document).pipe(
    Effect.map(({ id }) => id),
    Effect.mapError(() =>
      refuseCallers(source, `A ${source} document is missing its DID in id`)
    )
  );

const readSupplementalDocuments = Effect.fn("readSupplementalDocuments")(
  function* readSupplementalDocuments(
    files: CallerDocumentFiles,
    skip: SkipGeneratedName
  ) {
    const fs = yield* FileSystem.FileSystem;

    const reserved = yield* fs.readFileString(files.reserved).pipe(
      Effect.flatMap(Schema.decodeEffect(RawDocuments)),
      Effect.mapError(() =>
        refuseCallers(
          "reserved",
          "Reserved file must be an array of public DID documents in DID_DOCUMENTS format"
        )
      )
    );

    const extras = yield* fs.readFileString(files.extras).pipe(
      Effect.flatMap(Schema.decodeEffect(ExtraDocuments)),
      Effect.mapError(() =>
        refuseCallers(
          "extras",
          "Extras file must be an array of entries with name and public document"
        )
      )
    );

    const reservedEntries: Candidate[] = [];

    for (const document of reserved) {
      const did = yield* documentDid(document, "reserved");

      if (skipReservedDid(did, skip)) {
        continue;
      }

      const name = Option.getOrUndefined(callerName(did));

      if (name === undefined || !matchesReservedName(did, name)) {
        return yield* refuseCallers(
          "reserved",
          "Reserved document id must name a bare reserved fleet caller or match the fleet name template"
        );
      }

      reservedEntries.push({ did, document, name });
    }

    const extraEntries: Candidate[] = [];

    for (const { document, name } of extras) {
      if (skip(name)) {
        continue;
      }

      const did = yield* documentDid(document, "extras");

      if (!matchesFleetName(did, name)) {
        return yield* refuseCallers(
          "template",
          `Extra DID does not match fleet name ${name}`
        );
      }

      extraEntries.push({ did, document, name });
    }

    return [reservedEntries, extraEntries] as const;
  }
);

type Directory = Effect.Success<ReturnType<typeof readCallerDirectory>>;

const compareDids = (
  left: typeof Document.Type,
  right: typeof Document.Type
) => {
  if (left.id === right.id) {
    return 0;
  }

  return left.id < right.id ? -1 : 1;
};

type SourceKind = "export" | "manifest" | "reserved" | "extras";

const checkName = Effect.fn("checkCallerName")(function* checkName(
  bindings: Map<string, string>,
  name: string,
  did: string,
  kind: "seed" | "conflict"
) {
  const existing = bindings.get(name);

  if (existing !== undefined && existing !== did) {
    return yield* refuseCallers(
      kind,
      `Found conflicting DIDs for name ${name}`
    );
  }

  return bindings.set(name, did);
});

const decodeCandidate = Effect.fn("decodeCallerCandidate")(
  function* decodeCandidate(entry: Candidate, kind: SourceKind) {
    const { did, name } = entry;

    if (
      Option.getOrUndefined(callerName(did)) !== name ||
      !matchesReservedName(did, name)
    ) {
      return yield* refuseCallers(
        "template",
        `Directory DID does not match fleet name ${JSON.stringify(name)}`
      );
    }

    const document = yield* Schema.decodeUnknownEffect(Document)(
      entry.document
    ).pipe(
      Effect.mapError(() =>
        refuseCallers(
          kind,
          `Caller entry for ${name} is not a public DID document; private JWK fields such as d are forbidden`
        )
      )
    );

    if (document.id !== did) {
      return yield* refuseCallers(
        "template",
        `Caller document ID does not match fleet name ${name}`
      );
    }

    return document;
  }
);

const directoryCandidates = (
  directory: Directory,
  reservedDids: ReadonlySet<string>,
  warnings: Set<string>
) => {
  const retired = new Set<string>();

  for (const { did, name } of directory.retirements) {
    if (
      Option.getOrUndefined(callerName(did)) !== name ||
      !matchesReservedName(did, name)
    ) {
      warnings.add(
        `Retirement name ${JSON.stringify(name)} does not match its fleet DID; excluding by DID`
      );
    }

    retired.add(did);
  }

  const directoryEntries = directory.names.filter(({ did, name, status }) => {
    if (status === "retired") {
      return false;
    }

    if (did.endsWith(FLEET_SUFFIX) || reservedDids.has(did)) {
      return true;
    }

    if (directory.snapshot && did.endsWith(RESERVED_FLEET_SUFFIX)) {
      warnings.add(
        `Skipping snapshot row ${JSON.stringify(name)}: reserved DID is absent from the reserved file`
      );
    }

    return false;
  });

  return { directoryEntries, retired };
};

const seedBindings = Effect.fn("bindSeedNames")(function* bindSeedNames(
  dids: Iterable<string>
) {
  const bindings = new Map<string, string>();

  for (const did of dids) {
    const name = Option.getOrUndefined(callerName(did));

    if (name === undefined) {
      return yield* refuseCallers(
        "seed",
        "Legacy seed has a DID without a valid fleet name"
      );
    }

    yield* checkName(bindings, name, did, "seed");
  }

  return bindings;
});

interface DecodedDocument {
  readonly public: typeof Document.Type;
  readonly raw: Schema.Json | undefined;
}

const warnAboutSnapshotSeed = (
  directory: Directory,
  legacy: ReadonlyMap<string, DecodedDocument>,
  warnings: Set<string>
) => {
  if (!directory.snapshot) {
    return;
  }

  const retired = new Set(directory.retirements.map(({ did }) => did));

  for (const { did, document, status } of directory.seedRows) {
    const seed = legacy.get(did);

    if (seed !== undefined && !isDeepStrictEqual(seed.raw, document)) {
      const name = Option.getOrUndefined(callerName(did)) ?? did;
      warnings.add(
        `Snapshot row document differs from the legacy seed for ${name}; keeping the seed`
      );
    }

    if (status === "retired") {
      retired.add(did);
    }
  }

  for (const did of retired) {
    if (legacy.has(did)) {
      const name = Option.getOrUndefined(callerName(did)) ?? did;
      warnings.add(
        `Snapshot retires ${name}, but the trusted legacy seed keeps that caller permitted`
      );
    }
  }
};

const mergeAdditions = Effect.fn("mergeCallerAdditions")(
  function* mergeAdditions(
    directory: Directory,
    legacy: ReadonlyMap<string, DecodedDocument>,
    reserved: readonly Candidate[],
    extras: readonly Candidate[],
    warnings: Set<string>
  ) {
    const reservedDids = new Set(reserved.map(({ did }) => did));

    const { directoryEntries, retired } = directoryCandidates(
      directory,
      reservedDids,
      warnings
    );

    const sources = [
      {
        entries: directoryEntries,
        kind: directory.snapshot ? "manifest" : "export",
      },
      { entries: reserved, kind: "reserved" },
      { entries: extras, kind: "extras" },
    ] as const;

    const seen = new Map<string, DecodedDocument>();

    const bindings = yield* seedBindings(legacy.keys());
    const added = new Map<string, typeof Document.Type>();

    for (const source of sources) {
      const sourceDids = new Set<string>();

      for (const entry of source.entries) {
        const { did, name } = entry;

        if (retired.has(did)) {
          warnings.add(
            `Skipping retired DID for ${JSON.stringify(name)} in generated additions; the legacy seed is unchanged`
          );
          continue;
        }

        if (source.kind !== "manifest" && sourceDids.has(did)) {
          return yield* refuseCallers(
            source.kind,
            `A caller input repeats the fleet DID for ${name}`
          );
        }

        sourceDids.add(did);

        const document = yield* decodeCandidate(entry, source.kind);
        yield* checkName(bindings, name, did, "conflict");

        const previous = seen.get(did);

        if (previous !== undefined) {
          if (!isDeepStrictEqual(previous.public, document)) {
            return yield* refuseCallers(
              "conflict",
              `Caller inputs have conflicting documents for ${name}`
            );
          }

          if (!isDeepStrictEqual(previous.raw, entry.document)) {
            warnings.add(
              `Public documents agree for ${name}; dropped fields differ between inputs`
            );
          }
        }

        const candidate = { public: document, raw: entry.document };
        seen.set(did, candidate);

        if (!legacy.has(did)) {
          added.set(did, document);
        }
      }
    }

    return added;
  }
);

const invalidSeed = () =>
  refuseCallers(
    "seed",
    "Legacy seed is not an array of public DID documents; a private JWK field such as d is forbidden"
  );

const decodeLegacySeed = Effect.fn("decodeLegacyCallerSeed")(
  function* decodeLegacySeed(seed: string) {
    const rows = yield* Schema.decodeEffect(RawDocuments)(seed).pipe(
      Effect.mapError(invalidSeed)
    );

    const legacy = new Map<string, DecodedDocument>();

    for (const raw of rows) {
      const document = yield* Schema.decodeUnknownEffect(Document)(raw).pipe(
        Effect.mapError(invalidSeed)
      );

      if (legacy.has(document.id)) {
        return yield* refuseCallers("seed", "Legacy seed repeats a DID");
      }

      legacy.set(document.id, { public: document, raw });
    }

    if (legacy.size !== 0) {
      yield* decodeCallers(seed).pipe(
        Effect.catchCause(() =>
          refuseCallers(
            "seed",
            "Legacy seed contains invalid caller names or grants"
          )
        )
      );
    }

    return legacy;
  }
);

const generateWithWarnings = Effect.fn("generateCallersWithWarnings")(
  function* generateWithWarnings(
    directorySource: string,
    seedFile: string,
    out: string,
    warnings: Set<string>,
    skip: SkipGeneratedName,
    documents?: CallerDocumentFiles
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.resolve(out);

    const seed = yield* fs
      .readFileString(seedFile)
      .pipe(
        Effect.mapError(() =>
          refuseCallers("seed", "Cannot read the legacy seed")
        )
      );

    const legacy = yield* decodeLegacySeed(seed);

    const directory = yield* readCallerDirectory(
      directorySource,
      new Set(legacy.keys())
    );

    warnAboutSnapshotSeed(directory, legacy, warnings);

    const [reserved = [], extras = []] =
      documents === undefined
        ? []
        : yield* readSupplementalDocuments(documents, skip);

    const added = yield* mergeAdditions(
      {
        ...directory,
        names: directory.names.filter(({ name }) => !skip(name)),
      },
      legacy,
      reserved,
      extras,
      warnings
    );

    if (legacy.size + added.size === 0) {
      return yield* refuseCallers(
        "seed",
        "No public callers remain after filtering the inputs"
      );
    }

    const closingBracket = seed.lastIndexOf("]");

    const separator = legacy.size === 0 ? "\n" : ",\n";

    const text =
      added.size === 0
        ? seed
        : `${seed.slice(0, closingBracket)}${separator}${[...added.values()]
            .toSorted(compareDids)
            .map((doc) => JSON.stringify(doc))
            .join(",\n")}\n${seed.slice(closingBracket)}`;

    yield* decodeCallers(text);

    const stage = yield* fs.makeTempDirectoryScoped({
      directory: path.dirname(target),
      prefix: ".mischief-callers-",
    });

    const staged = path.join(stage, "callers.json");
    yield* fs.writeFileString(staged, text, { mode: 0o600 });
    yield* fs.link(staged, target).pipe(
      Effect.mapError(
        () =>
          new CallerGenerationRefused({
            message:
              "Could not publish callers file; choose a new output file in a writable directory on a filesystem supporting hard links, then retry generate-callers",
          })
      )
    );

    return {
      added: added.size,
      legacy: legacy.size,
      total: legacy.size + added.size,
    };
  },
  Effect.scoped
);

export const generateCallersFile = Effect.fn("generateCallersFile")(
  function* generateCallersFile(
    directorySource: string,
    seedFile: string,
    out: string,
    documents?: CallerDocumentFiles
  ) {
    const warnings = new Set<string>();
    const ephemeral = countEphemeralNames();

    return yield* generateWithWarnings(
      directorySource,
      seedFile,
      out,
      warnings,
      ephemeral.skip,
      documents
    ).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.forEach(
            [...warnings, ...ephemeral.warning()].toSorted(),
            (warning) => Console.error(warning),
            { discard: true }
          )
        )
      )
    );
  }
);
