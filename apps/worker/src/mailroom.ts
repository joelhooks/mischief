import {
  base64url,
  importSigning,
  ownIdentity,
  prepare,
  serviceToken,
  unbase64url,
} from "@rat-king/mailbox-client";
import type {
  IdentityValue,
  OpenedMessage,
  PeerDocument,
  SealedMessage,
  SendOutcome,
} from "@rat-king/mailbox-client";
import {
  Clock,
  Crypto,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect";
import type { Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Mailroom, SendVerdict } from "./mailroom-port.js";
import type { Inbound, SendVerdictValue } from "./mailroom-port.js";
import { PostboxFailed } from "./postbox-failed.js";
import { DESK, OWN_NAME } from "./postbox.js";

const LIST_NAMES = "sh.mschf.ratking.identity.listNames";

const DIRECTORY_TTL_MS = 600_000;

export interface MailroomConfig {
  readonly endpoint: string;
  readonly identity: IdentityValue;
  readonly serviceDid: string;
}

const NamesPage = Schema.Struct({
  cursor: Schema.optionalKey(Schema.String),
  names: Schema.Array(
    Schema.Struct({
      did: Schema.String,
      document: Schema.Json,
      name: Schema.String,
    })
  ),
});

interface Directory {
  readonly at: number;
  readonly byDid: ReadonlyMap<string, string>;
  readonly byName: ReadonlyMap<string, string>;
  readonly documents: readonly PeerDocument[];
}

type Prepared = Effect.Success<ReturnType<typeof prepare>>;

const failed = (reason: string) => new PostboxFailed({ reason });

type Envelope = SealedMessage["envelope"];

const StoredEnvelope = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({ ciphertext: Schema.String, enc: Schema.String }),
    [Schema.Record(Schema.String, Schema.Json)]
  )
);

export const encodeEnvelope = (envelope: Envelope) =>
  JSON.stringify({
    ...envelope,
    ciphertext: base64url(envelope.ciphertext),
    enc: base64url(envelope.enc),
  });

export const decodeEnvelope = (text: string) =>
  Schema.decodeUnknownEffect(StoredEnvelope)(text).pipe(
    Effect.map((stored): Envelope => {
      const restored = {
        ...stored,
        ciphertext: unbase64url(stored.ciphertext),
        enc: unbase64url(stored.enc),
      };

      // SAFETY: the text is an envelope this Postbox sealed and encoded; sendSealed re-decodes it with the lexicon's Send.Input schema before sending.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return restored as Envelope;
    }),
    Effect.mapError(() => failed("the stored envelope did not decode"))
  );

const verdictOf = (outcome: SendOutcome): SendVerdictValue => {
  if (Predicate.isTagged(outcome, "Accepted")) {
    return SendVerdict.cases.Accepted.make({});
  }

  if (Predicate.isTagged(outcome, "Rejected")) {
    return outcome.error.status === 409
      ? SendVerdict.cases.Conflict.make({})
      : SendVerdict.cases.Refused.make({ reason: outcome.error.reason });
  }

  if (Predicate.isTagged(outcome, "Uncertain")) {
    return SendVerdict.cases.Uncertain.make({ reason: outcome.error.reason });
  }

  return SendVerdict.cases.Refused.make({ reason: outcome.reason });
};

export const inboundOf = (message: OpenedMessage): Inbound => ({
  body: message.body,
  messageId: message.tid,
  replyTo: Option.fromNullishOr(message.replyTo?.messageId),
  senderDid: message.senderDid,
});

export const openMailroom = (config: MailroomConfig) =>
  Effect.gen(function* openMailroomFor() {
    const context = yield* Effect.context<
      HttpClient.HttpClient | Scope.Scope
    >();

    const random = yield* Crypto.Crypto;
    const http = yield* HttpClient.HttpClient;

    const own = yield* ownIdentity(config.identity).pipe(
      Effect.mapError((error) => failed(error.reason))
    );

    const signing = yield* importSigning(config.identity).pipe(
      Effect.mapError(() =>
        failed("the Postbox identity's signing key did not import")
      )
    );

    const audience = `${config.serviceDid.replace(/#mailbox$/u, "")}#mailbox`;

    const page = (cursor: Option.Option<string>) =>
      Effect.gen(function* listPage() {
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

        const token = yield* serviceToken(
          {
            aud: audience,
            exp: now + 50,
            iat: now,
            iss: config.identity.did,
            jti: (yield* random.randomUUIDv4.pipe(
              Effect.mapError(() => failed("no randomness for a token id"))
            )).replaceAll("-", ""),
            lxm: LIST_NAMES,
          },
          signing
        ).pipe(Effect.mapError(() => failed("listNames token did not sign")));

        const query = new URLSearchParams({ limit: "100" });

        if (Option.isSome(cursor)) {
          query.set("cursor", cursor.value);
        }

        const response = yield* http
          .execute(
            HttpClientRequest.get(
              `${config.endpoint}/xrpc/${LIST_NAMES}?${query.toString()}`
            ).pipe(HttpClientRequest.bearerToken(token))
          )
          .pipe(
            Effect.mapError(() =>
              failed("the Issuer's listNames is unreachable")
            )
          );

        if (response.status !== 200) {
          return yield* failed(
            `the Issuer refused listNames with HTTP ${response.status}; check that ${OWN_NAME} is registered`
          );
        }

        return yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(NamesPage)),
          Effect.mapError(() =>
            failed("the Issuer's listNames answer did not decode")
          )
        );
      });

    const listAll = Effect.gen(function* listAll() {
      const entries: (typeof NamesPage.Type)["names"][number][] = [];
      let cursor = Option.none<string>();

      for (let index = 0; index < 50; index += 1) {
        const listed = yield* page(cursor);

        entries.push(...listed.names);
        cursor = Option.fromNullishOr(listed.cursor);

        if (Option.isNone(cursor)) {
          break;
        }
      }

      return {
        at: yield* Clock.currentTimeMillis,
        byDid: new Map(entries.map(({ did, name }) => [did, name])),
        byName: new Map(entries.map(({ did, name }) => [name, did])),
        // SAFETY: the Issuer publishes DID documents; prepare re-decodes each one with the mailbox's Document schema.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        documents: entries.map(({ document }) => document as PeerDocument),
      } satisfies Directory;
    });

    const state = yield* Ref.make(
      Option.none<{
        readonly directory: Directory;
        readonly prepared: Prepared;
      }>()
    );

    const refresh = Effect.gen(function* refreshDirectory() {
      const directory = yield* listAll;

      const prepared = yield* prepare({
        endpoint: config.endpoint,
        names: { from: OWN_NAME, peers: Object.fromEntries(directory.byDid) },
        own,
        peers: directory.documents,
        serviceDid: config.serviceDid,
      }).pipe(
        Effect.mapError((error) => failed(error.reason)),
        Effect.provideContext(context)
      );

      const next = { directory, prepared };

      yield* Ref.set(state, Option.some(next));

      return next;
    });

    const current = (stale: (directory: Directory) => boolean) =>
      Effect.gen(function* currentDirectory() {
        const now = yield* Clock.currentTimeMillis;
        const held = yield* Ref.get(state);

        return Option.isSome(held) &&
          now - held.value.directory.at < DIRECTORY_TTL_MS &&
          !stale(held.value.directory)
          ? held.value
          : yield* refresh;
      });

    const seal = (to: string, body: string) =>
      Effect.gen(function* sealFor() {
        const { directory, prepared } = yield* current(
          ({ byName }) => !byName.has(to)
        );

        const did = directory.byName.get(to);

        if (did === undefined) {
          return yield* failed(
            `${to} is not a Rat King name the Issuer knows. Use the recipient's registered name, such as pi-durable/desk`
          );
        }

        const sealed = yield* prepared
          .sealPayload(did, body)
          .pipe(Effect.mapError((error) => failed(error.reason)));

        return {
          envelope: encodeEnvelope(sealed.envelope),
          messageId: sealed.messageId,
        };
      });

    const send = (envelope: string) =>
      decodeEnvelope(envelope).pipe(
        Effect.matchEffect({
          onFailure: ({ reason }) =>
            Effect.succeed(SendVerdict.cases.Refused.make({ reason })),
          onSuccess: (decoded) =>
            current(() => false).pipe(
              Effect.flatMap(({ prepared }) => prepared.sendSealed(decoded)),
              Effect.map(verdictOf),
              Effect.catchTag("PostboxFailed", ({ reason }) =>
                Effect.succeed(SendVerdict.cases.Uncertain.make({ reason }))
              )
            ),
        })
      );

    const layer = Layer.succeed(
      Mailroom,
      Mailroom.of({
        nameOf: (did) =>
          current(({ byDid }) => !byDid.has(did)).pipe(
            Effect.map(({ directory }) =>
              Option.fromNullishOr(directory.byDid.get(did))
            ),
            Effect.orElseSucceed(() => Option.none<string>())
          ),
        seal,
        send,
        surface: (summary, body) =>
          seal(DESK, `${summary}\n\n${body}`).pipe(
            Effect.flatMap(({ envelope }) => send(envelope)),
            Effect.tap((verdict) =>
              SendVerdict.guards.Accepted(verdict)
                ? Effect.void
                : Effect.logWarning(
                    `Postbox could not reach ${DESK}: ${summary}`
                  )
            ),
            Effect.catchTag("PostboxFailed", ({ reason }) =>
              Effect.logWarning(
                `Postbox could not reach ${DESK} (${reason}): ${summary}`
              )
            ),
            Effect.asVoid
          ),
      })
    );

    const consume = <E, R>(
      handler: (message: Inbound, seq: number) => Effect.Effect<void, E, R>,
      afterSeq: number
    ) =>
      current(() => false).pipe(
        Effect.flatMap(({ prepared }) =>
          prepared.consume(
            (message, { seq }) => handler(inboundOf(message), seq),
            {
              afterSeq,
              harness: {
                $type: "sh.mschf.ratking.runtime.lease#other",
                kind: "mischief-postbox",
              },
              onSkip: ({ reason, seq }) =>
                Effect.logWarning(`Postbox skipped message ${seq}: ${reason}`),
            }
          )
        )
      );

    return { consume, layer };
  });
