import { Effect, FileSystem, Path, Schema } from "effect";
import * as Digest from "effect/crypto/Digest";

const Entry = Schema.Struct({
  did: Schema.String,
  document: Schema.optionalKey(Schema.Json),
  name: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["live", "idle", "retired"])),
});

const CompleteList = {
  complete: Schema.Literal(true),
  cursor: Schema.optionalKey(Schema.Never),
  total: Schema.Int,
};

const DirectoryExport = Schema.fromJsonString(
  Schema.Struct({ ...CompleteList, names: Schema.Array(Schema.Json) })
);

const ExportRowDid = Schema.Struct({ did: Schema.String });

const ExportEntry = Schema.Struct({ ...Entry.fields, document: Schema.Json });

const isRetiredExportRow = Schema.is(
  Schema.Struct({
    did: Schema.String,
    name: Schema.String,
    status: Schema.Literal("retired"),
  })
);

const SnapshotId = Schema.String.check(Schema.isUUID());

const Issuer = Schema.String.check(Schema.isPattern(/\S/u));

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

const SnapshotNames = Schema.fromJsonString(
  Schema.Struct({
    ...CompleteList,
    names: Schema.Array(Entry),
    snapshot: SnapshotId,
  })
);

const SnapshotRetired = Schema.fromJsonString(
  Schema.Struct({
    ...CompleteList,
    retired: Schema.Array(
      Schema.Struct({ did: Schema.String, name: Schema.String })
    ),
    snapshot: SnapshotId,
  })
);

const SnapshotIssuers = Schema.fromJsonString(
  Schema.Record(Schema.String, Issuer)
);

const SnapshotManifest = Schema.fromJsonString(
  Schema.Struct({
    pages: Schema.NonEmptyArray(
      Schema.Struct({
        issuer: Issuer,
        names: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        retired: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      })
    ),
    sha256: Schema.Struct({
      "issuers.json": Hash,
      "names.json": Hash,
      "retired.json": Hash,
    }),
    snapshot: SnapshotId,
    totals: Schema.Struct({ names: Schema.Int, retired: Schema.Int }),
  })
);

export class CallerGenerationRefused extends Schema.TaggedError<
  CallerGenerationRefused,
  { readonly brand: unique symbol }
>()("CallerGenerationRefused", { message: Schema.String }) {}

const nextCall = {
  conflict:
    "Ask the Rat King operator to reconcile the active name bindings or public documents, refresh the affected inputs, then retry generate-callers",
  export:
    "Run export-fleet-directory with all pages in a new export, then retry generate-callers",
  extras:
    "Refresh the named public records in <extra-documents.json>, then retry generate-callers",
  manifest:
    "Run ratking snapshot --out <new-bundle> and save its JSON stdout as <new-bundle>/manifest.json, then retry generate-callers with that bundle",
  reserved:
    "Replace <reserved-documents.json> with the fleet-only public DID_DOCUMENTS array, then retry generate-callers",
  seed: "Supply the previous trusted <legacy-seed.json> with valid public callers and grants, then retry generate-callers",
  source:
    "Pass a readable snapshot directory or a complete directory-export.json as the first generate-callers argument",
  template:
    "Correct the named input row to use the Rat King name-derived fleet DID (with matching public document id), then retry generate-callers",
} as const;

export const refuseCallers = (kind: keyof typeof nextCall, reason: string) =>
  new CallerGenerationRefused({
    message: `${reason}. No callers file written. ${nextCall[kind]}`,
  });

const refuseSnapshot = (reason: string) => refuseCallers("manifest", reason);

const readSnapshot = Effect.fn("readCallerSnapshot")(function* readSnapshot(
  directory: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;

  const manifest = yield* fs
    .readFileString(path.join(directory, "manifest.json"))
    .pipe(
      Effect.flatMap(Schema.decodeEffect(SnapshotManifest)),
      Effect.mapError(() =>
        refuseSnapshot(
          "Cannot read the Rat King snapshot receipt as manifest.json"
        )
      )
    );

  const verified = (file: keyof typeof manifest.sha256) =>
    Effect.gen(function* verifiedSnapshotBytes() {
      const bytes = yield* fs
        .readFile(path.join(directory, file))
        .pipe(
          Effect.mapError(() => refuseSnapshot(`Cannot read snapshot ${file}`))
        );

      if (
        (yield* digest.digestHex(Digest.sha256, bytes)) !==
        manifest.sha256[file]
      ) {
        return yield* refuseSnapshot(
          `Snapshot SHA-256 manifest mismatch for ${file}`
        );
      }

      return new TextDecoder().decode(bytes);
    });

  const names = yield* verified("names.json").pipe(
    Effect.flatMap(Schema.decodeEffect(SnapshotNames)),
    Effect.catchTag("SchemaError", () =>
      refuseSnapshot("Snapshot names.json is not a complete names list")
    )
  );

  const retired = yield* verified("retired.json").pipe(
    Effect.flatMap(Schema.decodeEffect(SnapshotRetired)),
    Effect.catchTag("SchemaError", () =>
      refuseSnapshot("Snapshot retired.json is not a complete retirement list")
    )
  );

  const issuers = yield* verified("issuers.json").pipe(
    Effect.flatMap(Schema.decodeEffect(SnapshotIssuers)),
    Effect.catchTag("SchemaError", () =>
      refuseSnapshot("Snapshot issuers.json is not a placement map")
    )
  );

  if (
    manifest.snapshot !== names.snapshot ||
    manifest.snapshot !== retired.snapshot ||
    manifest.totals.names !== names.names.length ||
    manifest.totals.retired !== retired.retired.length ||
    names.total !== names.names.length ||
    retired.total !== retired.retired.length
  ) {
    return yield* refuseSnapshot(
      "Snapshot IDs or totals do not match the manifest and entries"
    );
  }

  const retirements = [
    ...retired.retired,
    ...names.names.filter(({ status }) => status === "retired"),
  ];

  const distinctNames = new Set(names.names.map(({ name }) => name));
  const issuerLabels = new Set(manifest.pages.map(({ issuer }) => issuer));

  if (
    issuerLabels.size !== manifest.pages.length ||
    Object.keys(issuers).length !== distinctNames.size ||
    [...distinctNames].some((name) => {
      const issuer = issuers[name];

      return (
        !Object.hasOwn(issuers, name) ||
        issuer === undefined ||
        !issuerLabels.has(issuer)
      );
    })
  ) {
    return yield* refuseSnapshot(
      "Snapshot placements do not match its names and issuer receipts"
    );
  }

  return { names: names.names, retirements, snapshot: true };
}, Effect.provide(Digest.layerWebCrypto));

export const readCallerDirectory = Effect.fn("readCallerDirectory")(
  function* readCallerDirectory(source: string, seedDids: ReadonlySet<string>) {
    const fs = yield* FileSystem.FileSystem;

    const info = yield* fs
      .stat(source)
      .pipe(
        Effect.mapError(() =>
          refuseCallers("source", "Cannot open the Rat King directory source")
        )
      );

    if (info.type === "Directory") {
      return yield* readSnapshot(source);
    }

    const directory = yield* fs.readFileString(source).pipe(
      Effect.flatMap(Schema.decodeEffect(DirectoryExport)),
      Effect.mapError(() =>
        refuseCallers(
          "export",
          "Cannot read a complete public Rat King directory export"
        )
      )
    );

    if (directory.total !== directory.names.length) {
      return yield* refuseCallers(
        "export",
        "Public directory total does not match its entries"
      );
    }

    const names: (typeof Entry.Type)[] = [];
    const retirements: { did: string; name: string }[] = [];

    for (const row of directory.names) {
      const { did } = yield* Schema.decodeUnknownEffect(ExportRowDid)(row).pipe(
        Effect.mapError(() =>
          refuseCallers("export", "A directory export row has no DID")
        )
      );

      if (isRetiredExportRow(row)) {
        retirements.push({ did, name: row.name });
      }

      if (!seedDids.has(did)) {
        const entry = yield* Schema.decodeUnknownEffect(ExportEntry)(row).pipe(
          Effect.mapError(() =>
            refuseCallers(
              "export",
              "A directory export row has no valid name, status or document"
            )
          )
        );

        names.push(entry);
      }
    }

    return {
      names,
      retirements,
      snapshot: false,
    };
  }
);
