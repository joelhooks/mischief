import { isDeepStrictEqual } from "node:util";

import { callerName } from "@mischief/core";
import { Document, Documents } from "@rat-king/mailbox-client/auth";
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect";

import {
  CallerGenerationRefused,
  readCallerDirectory,
  refuseDirectory,
} from "./caller-directory.ts";
import { decodeCallers } from "./callers.ts";

const FLEET_SUFFIX = ".pi.ratking-fleet.invalid";

const RESERVED_FLEET_SUFFIX = ".ratking-fleet.invalid";

const matchesFleetName = (did: string, name: string) =>
  did === `did:web:${name.replace("/", ".")}${FLEET_SUFFIX}` &&
  Option.getOrUndefined(callerName(did)) === name;

const matchesReservedName = (did: string, name: string) =>
  matchesFleetName(did, name) ||
  (!name.includes("/") && did === `did:web:${name}${RESERVED_FLEET_SUFFIX}`);

const DocumentId = Schema.Struct({ id: Schema.String });

const ReservedDocuments = Schema.fromJsonString(Schema.Array(Schema.Json));

const ExtraDocuments = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, document: Schema.Json }))
);

interface CallerDocumentFiles {
  readonly reserved: string;
  readonly extras: string;
}

interface Candidate {
  readonly did: string;
  readonly document: Schema.Json;
  readonly name: string;
}

const documentDid = (document: Schema.Json, source: "Reserved" | "Extra") =>
  Schema.decodeUnknownEffect(DocumentId)(document).pipe(
    Effect.map(({ id }) => id),
    Effect.mapError(() =>
      refuseDirectory(`${source} document is missing its DID in id`)
    )
  );

const readSupplementalDocuments = Effect.fn("readSupplementalDocuments")(
  function* readSupplementalDocuments(files: CallerDocumentFiles) {
    const fs = yield* FileSystem.FileSystem;

    const reserved = yield* fs.readFileString(files.reserved).pipe(
      Effect.flatMap(Schema.decodeEffect(ReservedDocuments)),
      Effect.mapError(() =>
        refuseDirectory(
          "Reserved file must be an array of public DID documents in DID_DOCUMENTS format"
        )
      )
    );

    const extras = yield* fs.readFileString(files.extras).pipe(
      Effect.flatMap(Schema.decodeEffect(ExtraDocuments)),
      Effect.mapError(() =>
        refuseDirectory(
          "Extras file must be an array of entries with name and public document"
        )
      )
    );

    const reservedEntries: Candidate[] = [];

    for (const document of reserved) {
      const did = yield* documentDid(document, "Reserved");
      const name = Option.getOrUndefined(callerName(did));

      if (name === undefined || !matchesReservedName(did, name)) {
        return yield* refuseDirectory(
          "Reserved document id must name a bare reserved fleet caller or match the fleet name template"
        );
      }

      reservedEntries.push({ did, document, name });
    }

    const extraEntries: Candidate[] = [];

    for (const { document, name } of extras) {
      const did = yield* documentDid(document, "Extra");

      if (!matchesFleetName(did, name)) {
        return yield* refuseDirectory(
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

const mergeAdditions = Effect.fn("mergeCallerAdditions")(
  function* mergeAdditions(
    directory: Directory,
    legacyDids: ReadonlySet<string>,
    reserved: readonly Candidate[],
    extras: readonly Candidate[]
  ) {
    const reservedDids = new Set(reserved.map(({ did }) => did));

    const directoryEntries = directory.names.filter(
      ({ did, status }) =>
        status !== "retired" &&
        (did.endsWith(FLEET_SUFFIX) ||
          reservedDids.has(did) ||
          (directory.snapshot && did.endsWith(RESERVED_FLEET_SUFFIX)))
    );

    const sources = [
      {
        entries: directoryEntries,
        directory: true,
        allowDuplicates: directory.snapshot,
      },
      { entries: reserved, directory: false, allowDuplicates: false },
      { entries: extras, directory: false, allowDuplicates: false },
    ];

    const seen = new Map<string, typeof Document.Type>();
    const snapshotDidsByName = new Map<string, string>();
    const suppressed = new Set<string>();
    const added = new Map<string, typeof Document.Type>();

    for (const source of sources) {
      const sourceDids = new Set<string>();

      for (const entry of source.entries) {
        const { did, name } = entry;

        if (
          source.directory &&
          (Option.getOrUndefined(callerName(did)) !== name ||
            !matchesReservedName(did, name))
        ) {
          return yield* refuseDirectory(
            `Directory DID does not match fleet name ${name}`
          );
        }

        if (!source.allowDuplicates && sourceDids.has(did)) {
          return yield* refuseDirectory(
            `A caller input repeats the fleet DID for ${name}`
          );
        }

        sourceDids.add(did);

        const document = yield* Schema.decodeUnknownEffect(Document)(
          entry.document
        ).pipe(
          Effect.mapError(() =>
            refuseDirectory(
              `Caller entry for ${name} is not a public DID document; private JWK fields such as d are forbidden`
            )
          )
        );

        if (document.id !== did) {
          return yield* refuseDirectory(
            `Caller document ID does not match fleet name ${name}`
          );
        }

        if (directory.retiredDids.has(did)) {
          suppressed.add(name);
          continue;
        }

        if (source.allowDuplicates) {
          const previousDid = snapshotDidsByName.get(name);

          if (previousDid !== undefined && previousDid !== did) {
            return yield* refuseDirectory(
              `Snapshot has conflicting DIDs for name ${name}`
            );
          }

          snapshotDidsByName.set(name, did);
        }

        const previous = seen.get(did);

        if (previous !== undefined && !isDeepStrictEqual(previous, document)) {
          return yield* refuseDirectory(
            `Caller inputs have conflicting documents for ${name}`
          );
        }

        seen.set(did, document);

        if (
          !legacyDids.has(did) &&
          (!source.directory || did.endsWith(FLEET_SUFFIX))
        ) {
          added.set(did, document);
        }
      }
    }

    return { added, suppressed };
  }
);

export const generateCallersFile = Effect.fn("generateCallersFile")(
  function* generateCallersFile(
    directorySource: string,
    seedFile: string,
    out: string,
    documents?: CallerDocumentFiles
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.resolve(out);

    const directory = yield* readCallerDirectory(directorySource);

    const [reserved = [], extras = []] =
      documents === undefined
        ? []
        : yield* readSupplementalDocuments(documents);

    const seed = yield* fs.readFileString(seedFile);
    const legacy = yield* decodeCallers(seed);

    const legacyDocs = yield* Schema.decodeEffect(
      Schema.fromJsonString(Documents)
    )(legacy.callers);

    const legacyDids = new Set(legacyDocs.map(({ id }) => id));

    if (legacyDids.size !== legacyDocs.length) {
      return yield* new CallerGenerationRefused({
        message:
          "Legacy seed repeats a DID. Supply the trusted public callers file with each DID listed once, then retry generate-callers",
      });
    }

    const { added, suppressed } = yield* mergeAdditions(
      directory,
      legacyDids,
      reserved,
      extras
    );

    const closingBracket = seed.lastIndexOf("]");

    const text =
      added.size === 0
        ? seed
        : `${seed.slice(0, closingBracket)},\n${[...added.values()]
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

    for (const name of [...suppressed].toSorted()) {
      yield* Console.error(
        `Skipping retired DID for ${name} in generated additions; the legacy seed is unchanged`
      );
    }

    return {
      added: added.size,
      legacy: legacyDids.size,
      total: legacyDids.size + added.size,
    };
  },
  Effect.scoped
);
