import { Effect, FileSystem, Path, Schema } from "effect";
import * as Digest from "effect/crypto/Digest";

const Entry = Schema.Struct({
  did: Schema.String,
  document: Schema.Json,
  name: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["live", "idle", "retired"])),
});

const CompleteList = {
  complete: Schema.Literal(true),
  cursor: Schema.optionalKey(Schema.Never),
  total: Schema.Int,
};

const DirectoryExport = Schema.fromJsonString(
  Schema.Struct({ ...CompleteList, names: Schema.Array(Entry) })
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

export const refuseDirectory = (reason: string) =>
  new CallerGenerationRefused({
    message: `${reason}. No callers file written. Check the input files, save the ratking snapshot receipt as manifest.json if using a bundle, then retry generate-callers`,
  });

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
        refuseDirectory(
          "Cannot read the Rat King snapshot receipt as manifest.json"
        )
      )
    );

  const verified = (file: keyof typeof manifest.sha256) =>
    Effect.gen(function* verifiedSnapshotBytes() {
      const bytes = yield* fs
        .readFile(path.join(directory, file))
        .pipe(
          Effect.mapError(() => refuseDirectory(`Cannot read snapshot ${file}`))
        );

      if (
        (yield* digest.digestHex(Digest.sha256, bytes)) !==
        manifest.sha256[file]
      ) {
        return yield* refuseDirectory(
          `Snapshot SHA-256 manifest mismatch for ${file}`
        );
      }

      return new TextDecoder().decode(bytes);
    });

  const names = yield* verified("names.json").pipe(
    Effect.flatMap(Schema.decodeEffect(SnapshotNames)),
    Effect.catchTag("SchemaError", () =>
      refuseDirectory("Snapshot names.json is not a complete names list")
    )
  );

  const retired = yield* verified("retired.json").pipe(
    Effect.flatMap(Schema.decodeEffect(SnapshotRetired)),
    Effect.catchTag("SchemaError", () =>
      refuseDirectory("Snapshot retired.json is not a complete retirement list")
    )
  );

  const issuers = yield* verified("issuers.json").pipe(
    Effect.flatMap(Schema.decodeEffect(SnapshotIssuers)),
    Effect.catchTag("SchemaError", () =>
      refuseDirectory("Snapshot issuers.json is not a placement map")
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
    return yield* refuseDirectory(
      "Snapshot IDs or totals do not match the manifest and entries"
    );
  }

  const retiredDids = new Set([
    ...retired.retired.map(({ did }) => did),
    ...names.names
      .filter(({ status }) => status === "retired")
      .map(({ did }) => did),
  ]);

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
    return yield* refuseDirectory(
      "Snapshot placements do not match its names and issuer receipts"
    );
  }

  return { names: names.names, retiredDids, snapshot: true };
}, Effect.provide(Digest.layerWebCrypto));

export const readCallerDirectory = Effect.fn("readCallerDirectory")(
  function* readCallerDirectory(source: string) {
    const fs = yield* FileSystem.FileSystem;

    const info = yield* fs
      .stat(source)
      .pipe(
        Effect.mapError(() =>
          refuseDirectory("Cannot open the Rat King directory source")
        )
      );

    if (info.type === "Directory") {
      return yield* readSnapshot(source);
    }

    const directory = yield* fs.readFileString(source).pipe(
      Effect.flatMap(Schema.decodeEffect(DirectoryExport)),
      Effect.mapError(() =>
        refuseDirectory(
          "Cannot read a complete public Rat King directory export"
        )
      )
    );

    if (directory.total !== directory.names.length) {
      return yield* refuseDirectory(
        "Public directory total does not match its entries"
      );
    }

    const retired = directory.names.filter(
      ({ status }) => status === "retired"
    );

    return {
      names: directory.names,
      retiredDids: new Set(retired.map(({ did }) => did)),
      snapshot: false,
    };
  }
);
