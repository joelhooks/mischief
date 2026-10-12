import {
  base64url,
  ownIdentity,
  prepare,
  unbase64url,
} from "@rat-king/mailbox-client";
import type {
  ConsumeOptions,
  IdentityValue,
  LeaseFence,
  OpenedMessage,
  SealedMessage,
  SendOutcome,
} from "@rat-king/mailbox-client";
import { Clock, Effect, Layer, Option, Predicate, Schema } from "effect";
import type { Scope } from "effect";
import type { HttpClient } from "effect/http";

import { canonicalName, didFor, nameFor } from "./fleet-names.js";
import { Mailroom, SendVerdict } from "./mailroom-port.js";
import type { Inbound, SendVerdictValue } from "./mailroom-port.js";
import { PostboxFailed } from "./postbox-failed.js";
import type { LeaseBook } from "./postbox-lease.js";
import { DESK, OWN_NAME } from "./postbox.js";

export interface MailroomConfig {
  readonly endpoint: string;
  readonly identity: IdentityValue;
  readonly leases: LeaseBook;
  readonly serviceDid: string;
}

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

export const verdictOf = (outcome: SendOutcome): SendVerdictValue => {
  if (Predicate.isTagged(outcome, "Accepted")) {
    return SendVerdict.cases.Accepted.make({});
  }

  if (Predicate.isTagged(outcome, "Rejected")) {
    const { error, reason, status } = outcome.error;

    if (status === 409 && error === "Conflict") {
      return SendVerdict.cases.Conflict.make({});
    }

    return error === "LeaseMismatch"
      ? SendVerdict.cases.Uncertain.make({ reason })
      : SendVerdict.cases.Refused.make({ reason });
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

    const own = yield* ownIdentity(config.identity).pipe(
      Effect.mapError((error) => failed(error.reason))
    );

    const names: Record<string, string> = {};
    const known = new Set<string>();

    const fence = Clock.currentTimeMillis.pipe(
      Effect.map((now) =>
        Option.getOrUndefined(
          Option.map(
            config.leases.held(now),
            ({ did, generation, leaseId }): LeaseFence => ({
              did,
              generation,
              leaseId,
            })
          )
        )
      )
    );

    const prepared = yield* prepare({
      endpoint: config.endpoint,
      names: { from: OWN_NAME, peers: names },
      own,
      peers: [],
      serviceDid: config.serviceDid,
    }).pipe(
      Effect.mapError((error) => failed(error.reason)),
      Effect.provideContext(context)
    );

    const peer = (to: string, did: string) =>
      known.has(did)
        ? Effect.void
        : prepared.refresh(did).pipe(
            Effect.mapError((failure) =>
              failed(
                failure.status === 404
                  ? `${to} has no Rat King mailbox: no document is published for ${did}. Use a registered desk name, such as pi-durable/desk`
                  : `${to}'s document could not be fetched (${failure.reason})`
              )
            ),
            Effect.tap(() => Effect.sync(() => known.add(did))),
            Effect.asVoid
          );

    const seal = (to: string, body: string) =>
      Effect.gen(function* sealFor() {
        const name = canonicalName(to);

        const did = yield* Option.match(didFor(name), {
          onNone: () =>
            Effect.fail(
              failed(
                `${to} is not a Rat King name. Names look like project/desk, such as pi-durable/desk`
              )
            ),
          onSome: Effect.succeed,
        });

        yield* peer(name, did);

        names[did] = name;

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
            fence.pipe(
              Effect.flatMap((held) => prepared.sendSealed(decoded, held)),
              Effect.map(verdictOf)
            ),
        })
      );

    const tell = (to: string, summary: string, body: string) =>
      seal(to, `${summary}\n\n${body}`).pipe(
        Effect.flatMap(({ envelope }) => send(envelope)),
        Effect.tap((verdict) =>
          SendVerdict.guards.Accepted(verdict)
            ? Effect.void
            : Effect.logWarning(`Postbox could not reach ${to}: ${summary}`)
        ),
        Effect.catchTag("PostboxFailed", ({ reason }) =>
          Effect.logWarning(
            `Postbox could not reach ${to} (${reason}): ${summary}`
          )
        ),
        Effect.asVoid
      );

    const layer = Layer.succeed(
      Mailroom,
      Mailroom.of({
        nameOf: (did) => Effect.succeed(nameFor(did)),
        seal,
        send,
        surface: (summary, body) => tell(DESK, summary, body),
        tell,
      })
    );

    const consume = <E, R>(
      handler: (message: Inbound, seq: number) => Effect.Effect<void, E, R>,
      afterSeq: number
    ) =>
      fence.pipe(
        Effect.flatMap((resume) => {
          const options: ConsumeOptions = {
            afterSeq,
            harness: {
              $type: "sh.mschf.ratking.runtime.lease#other",
              kind: "mischief-postbox",
            },
            onLease: (lease) =>
              Effect.sync(() => {
                config.leases.save({
                  did: config.identity.did,
                  expiresAt: Date.parse(lease.expiresAt),
                  generation: lease.generation,
                  leaseId: lease.leaseId,
                });
              }),
            onSkip: ({ reason, seq }) =>
              Effect.logWarning(`Postbox skipped message ${seq}: ${reason}`),
            unopenable: (event) =>
              prepared.refresh(event.envelope.aad.senderDid).pipe(
                Effect.tap(() =>
                  Effect.sync(() => known.add(event.envelope.aad.senderDid))
                ),
                Effect.flatMap(() => prepared.open(event.envelope)),
                Effect.matchEffect({
                  onFailure: (failure) =>
                    Effect.logWarning(
                      `Postbox could not open message ${event.seq} from ${event.envelope.aad.senderDid}: ${failure.reason}`
                    ).pipe(Effect.as(Option.none())),
                  onSuccess: (opened) => Effect.succeed(Option.some(opened)),
                })
              ),
          };

          return prepared.consume(
            (message, { seq }) => handler(inboundOf(message), seq),
            resume === undefined ? options : { ...options, resume }
          );
        })
      );

    return { consume, layer };
  });
