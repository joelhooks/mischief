import { callerName } from "@mischief/core";
import { Document, Documents } from "@rat-king/mailbox-client/auth";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import {
  CallerGenerationRefused,
  readCallerDirectory,
  refuseDirectory,
  sameDocument,
} from "./caller-directory.ts";
import { decodeCallers } from "./callers.ts";

const FLEET_SUFFIX = ".pi.ratking-fleet.invalid";

const RESERVED_FLEET_SUFFIX = ".ratking-fleet.invalid";

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

      if (!did.endsWith(RESERVED_FLEET_SUFFIX) || name === undefined) {
        return yield* refuseDirectory(
          "Reserved document id must be a recognized fleet DID"
        );
      }

      reservedEntries.push({ did, document, name });
    }

    const extraEntries: Candidate[] = [];

    for (const { document, name } of extras) {
      const did = yield* documentDid(document, "Extra");

      if (
        !did.endsWith(FLEET_SUFFIX) ||
        Option.getOrUndefined(callerName(did)) !== name
      ) {
        return yield* refuseDirectory(
          `Extra DID does not match fleet name ${name}`
        );
      }

      extraEntries.push({ did, document, name });
    }

    return [reservedEntries, extraEntries] as const;
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

    const supplemental =
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

    const directoryEntries = directory.names.filter(
      ({ did, status }) => did.endsWith(FLEET_SUFFIX) && status !== "retired"
    );

    const seen = new Map<string, Schema.Json>();
    const added = new Map<string, typeof Document.Type>();

    for (const source of [directoryEntries, ...supplemental]) {
      const sourceDids = new Set<string>();

      for (const entry of source) {
        const { did, name } = entry;

        if (Option.getOrUndefined(callerName(did)) !== name) {
          return yield* refuseDirectory(
            `Directory DID does not match fleet name ${name}`
          );
        }

        if (sourceDids.has(did)) {
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

        const previous = seen.get(did);

        if (previous !== undefined && !sameDocument(previous, entry.document)) {
          return yield* refuseDirectory(
            `Caller inputs have conflicting documents for ${name}`
          );
        }

        seen.set(did, entry.document);

        if (
          !legacyDids.has(did) &&
          !directory.retiredNames.has(name) &&
          !directory.retiredDids.has(did)
        ) {
          added.set(did, document);
        }
      }
    }

    const closingBracket = seed.lastIndexOf("]");

    const text =
      added.size === 0
        ? seed
        : `${seed.slice(0, closingBracket)},\n${[...added.values()]
            .toSorted((a, b) => a.id.localeCompare(b.id))
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
      legacy: legacyDids.size,
      total: legacyDids.size + added.size,
    };
  },
  Effect.scoped
);
