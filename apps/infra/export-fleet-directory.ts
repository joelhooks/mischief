import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Document, Identity, transportLayer } from "@rat-king/mailbox-client";
import {
  Config,
  Console,
  Context,
  Effect,
  FileSystem,
  Layer,
  Redacted,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";

class DirectoryExportRefused extends Schema.TaggedError<DirectoryExportRefused>()(
  "DirectoryExportRefused",
  { message: Schema.String }
) {}

const refuse = (message: string) => new DirectoryExportRefused({ message });

const LIST_NAMES = "sh.mschf.ratking.identity.listNames";

const Entry = Schema.Struct({
  did: Schema.String,
  document: Document,
  name: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["live", "idle", "retired"])),
});

const Page = Schema.Struct({
  cursor: Schema.optionalKey(Schema.NonEmptyString),
  names: Schema.Array(Entry),
});

type MailboxTransport = Layer.Success<ReturnType<typeof transportLayer>>;

const Transport = Context.Service<
  MailboxTransport,
  {
    readonly request: (query: {
      readonly nsid: typeof LIST_NAMES;
      readonly method: "GET";
      readonly params: {
        readonly all: true;
        readonly limit: number;
        readonly cursor?: string;
      };
      readonly input: undefined;
    }) => Effect.Effect<
      { readonly status: number; readonly body: Schema.Json },
      { readonly reason: string }
    >;
  }
>("@rat-king/lexicon/Transport");

const exportDirectory = Effect.fn("exportFleetDirectory")(
  function* exportFleetDirectory(out: string) {
    const transport = yield* Transport;
    const fs = yield* FileSystem.FileSystem;
    const names: (typeof Entry.Type)[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < 1000; page += 1) {
      const response = yield* transport
        .request({
          input: undefined,
          method: "GET",
          nsid: LIST_NAMES,
          params:
            cursor === undefined
              ? { all: true, limit: 100 }
              : { all: true, cursor, limit: 100 },
        })
        .pipe(
          Effect.mapError(() =>
            refuse(
              "Rat King directory read failed. Verify mailbox reachability and retry export-fleet-directory"
            )
          )
        );

      if (response.status !== 200) {
        return yield* refuse(
          `Rat King identity.listNames returned HTTP ${response.status}. Verify mailbox service DID and signing identity admission, then retry export-fleet-directory`
        );
      }

      const listed = yield* Schema.decodeUnknownEffect(Page)(
        response.body
      ).pipe(
        Effect.mapError(() =>
          refuse(
            "Invalid Rat King directory page; DID documents must contain only public JWKs, never d. Correct the source and retry export-fleet-directory"
          )
        )
      );

      names.push(...listed.names);

      if (listed.cursor === undefined) {
        yield* fs.writeFileString(
          out,
          `${JSON.stringify({ complete: true, names, total: names.length })}\n`,
          { flag: "wx", mode: 0o600 }
        );

        return yield* Console.log(JSON.stringify({ total: names.length }));
      }

      if (seen.has(listed.cursor)) {
        return yield* refuse(
          "Rat King repeated a directory cursor. No output written; retry export-fleet-directory against a healthy issuer"
        );
      }

      seen.add(listed.cursor);
      ({ cursor } = listed);
    }

    return yield* refuse(
      "Rat King issuer directory exceeded 1000 pages. No output written; review the publisher's page limit before retrying"
    );
  }
);

const program = Effect.gen(function* runExport() {
  const [endpoint, serviceDid, , out] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([
      Schema.NonEmptyString,
      Schema.NonEmptyString,
      Schema.Literal("--out"),
      Schema.NonEmptyString,
    ])
  )(process.argv.slice(2)).pipe(
    Effect.mapError(() =>
      refuse(
        "Use pnpm --filter @mischief/infra export-fleet-directory <mailbox-origin> <mailbox-service-did> --out <new-directory.json>"
      )
    )
  );

  const url = yield* Schema.decodeEffect(Schema.URLFromString)(endpoint).pipe(
    Effect.mapError(() =>
      refuse(
        "Set mailbox-origin to the configured Rat King HTTP(S) origin and retry export-fleet-directory"
      )
    )
  );

  if (
    url.origin !== endpoint ||
    (url.protocol !== "http:" && url.protocol !== "https:")
  ) {
    return yield* refuse(
      "Set mailbox-origin to the configured Rat King HTTP(S) origin, without a path, trailing slash or credentials, and retry export-fleet-directory"
    );
  }

  const credential = yield* Config.schema(
    Schema.Redacted(Schema.String),
    "RATKING_IDENTITY_JSON"
  );

  const identity = yield* Schema.decodeEffect(Schema.fromJsonString(Identity))(
    Redacted.value(credential)
  ).pipe(
    Effect.mapError(() =>
      refuse(
        "RATKING_IDENTITY_JSON is not a Rat King identity. Inject an existing identity with the secret runner and retry export-fleet-directory"
      )
    )
  );

  return yield* exportDirectory(out).pipe(
    Effect.provide(transportLayer(endpoint, `${serviceDid}#mailbox`, identity))
  );
});

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
  )
);
