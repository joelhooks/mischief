import { callerName } from "@mischief/core";
import { Document, Documents } from "@rat-king/mailbox-client/auth";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { decodeCallers } from "./callers.ts";

const DirectoryExport = Schema.fromJsonString(
  Schema.Struct({
    complete: Schema.Literal(true),
    cursor: Schema.optionalKey(Schema.Never),
    total: Schema.Int,
    names: Schema.Array(
      Schema.Struct({
        did: Schema.String,
        document: Schema.Json,
        name: Schema.String,
        status: Schema.optionalKey(
          Schema.Literals(["live", "idle", "retired"])
        ),
      })
    ),
  })
);

const FLEET_SUFFIX = ".pi.ratking-fleet.invalid";

export class CallerGenerationRefused extends Schema.TaggedError<CallerGenerationRefused>()(
  "CallerGenerationRefused",
  { message: Schema.String }
) {}

const refuse = (reason: string) =>
  new CallerGenerationRefused({
    message: `${reason}. No callers file written. Export every page of Rat King identity.listNames with all=true, then retry generate-callers`,
  });

export const generateCallersFile = Effect.fn("generateCallersFile")(
  function* generateCallersFile(
    directoryFile: string,
    seedFile: string,
    out: string
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.resolve(out);

    const directory = yield* fs.readFileString(directoryFile).pipe(
      Effect.flatMap(Schema.decodeEffect(DirectoryExport)),
      Effect.mapError(() =>
        refuse("Cannot read a complete public Rat King directory export")
      )
    );

    if (directory.total !== directory.names.length) {
      return yield* refuse("Public directory total does not match its entries");
    }

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

    const retiredNames = new Set(
      directory.names
        .filter(({ status }) => status === "retired")
        .map(({ name }) => name)
    );

    const added = new Map<string, typeof Document.Type>();

    for (const entry of directory.names.toSorted((a, b) =>
      a.did.localeCompare(b.did)
    )) {
      const { did, name } = entry;

      if (!did.endsWith(FLEET_SUFFIX) || retiredNames.has(name)) {
        continue;
      }

      if (Option.getOrUndefined(callerName(did)) !== name) {
        return yield* refuse(`Directory DID does not match fleet name ${name}`);
      }

      if (legacyDids.has(did)) {
        continue;
      }

      if (added.has(did)) {
        return yield* refuse(`Directory repeats the fleet DID for ${name}`);
      }

      const document = yield* Schema.decodeUnknownEffect(Document)(
        entry.document
      ).pipe(
        Effect.mapError(() =>
          refuse(
            `Directory entry for ${name} is not a public DID document; private JWK fields such as d are forbidden`
          )
        )
      );

      if (document.id !== did) {
        return yield* refuse(
          `Directory document ID does not match fleet name ${name}`
        );
      }

      added.set(did, document);
    }

    const closingBracket = seed.lastIndexOf("]");

    const text =
      added.size === 0
        ? seed
        : `${seed.slice(0, closingBracket)},\n${Array.from(added.values(), (doc) => JSON.stringify(doc)).join(",\n")}\n${seed.slice(closingBracket)}`;

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
