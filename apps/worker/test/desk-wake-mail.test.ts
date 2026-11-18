// @effect-diagnostics asyncFunction:off -- Offline fixture generates and exports ephemeral keys through WebCrypto's Promise API.
import { expect, it } from "@effect/vitest";
import { webCrypto } from "@mischief/plan-run";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import {
  encodePayload,
  Identity,
  ownIdentity,
  prepare,
} from "@rat-king/mailbox-client";
import { Effect, Layer, Logger, Option, Schema } from "effect";
import { HttpClient } from "effect/http";

import { routeDeskWake } from "../src/desk-wake-mail.js";
import type { DeskWake } from "../src/desk-wake-mail.js";
import { inboundOf } from "../src/mailroom.js";
import { readBatch } from "../src/postbox-inbox.js";
import type { Letter } from "../src/postbox-inbox.js";
import { leaseBook } from "../src/postbox-lease.js";
import { freshCaller } from "./callers.js";

const operator = "did:web:operator.ratking-fleet.invalid";

const payload = {
  $type: "sh.mschf.ratking.desk.wake",
  futureField: 42,
  messageId: "3n2mobhjsxmvu",
  name: "sample/desk",
  recordedAt: "2026-11-18T22:19:33.000Z",
  wake: true,
};

const readOpened = (enabled: boolean, allowed: string, open: Letter["open"]) =>
  Effect.gen(function* readWake() {
    const wakes: DeskWake[] = [];
    const events: string[] = [];
    const logs: string[] = [];

    const letter = {
      ack: Effect.sync(() => {
        events.push("ack");
      }),
      deliver: Effect.succeed(Option.none()),
      open,
    };

    yield* readBatch(
      {
        acquire: () =>
          Effect.succeed({
            did: operator,
            expiresAt: 300_000,
            generation: 1,
            leaseId: "lease-1",
          }),
        page: () => Effect.succeed([{ letter: Option.some(letter), seq: 4 }]),
        wait: () => Effect.die("the page is not empty"),
      },
      {
        advance: () => {
          events.push("advance");
        },
        cursor: () => 0,
        leases: leaseBook(nodeSqlStorage(":memory:")),
        receive: (mail) =>
          routeDeskWake(
            mail,
            enabled,
            allowed,
            (wake) =>
              Effect.sync(() => {
                events.push("wake");
                wakes.push(wake);
              }),
            () =>
              Effect.sync(() => {
                events.push("normal mail");
              })
          ),
      },
      100
    ).pipe(
      Effect.provide(
        Logger.layer([
          Logger.formatSimple.pipe(Logger.map((line) => logs.push(line))),
        ])
      )
    );

    return { events, logs, wakes };
  });

const read = (
  enabled: boolean,
  senderDid: string,
  body: string,
  allowed = operator
) =>
  readOpened(
    enabled,
    allowed,
    Effect.succeedSome({
      body,
      messageId: "wire-1",
      replyTo: Option.none(),
      senderDid,
    })
  );

const mailboxIdentity = Effect.fn("Test.mailboxIdentity")(
  function* mailboxIdentity(name: string) {
    const { did, document, key } = yield* freshCaller(name);

    const agreementKey = yield* Effect.promise(
      async () =>
        await crypto.subtle.generateKey(
          { name: "ECDH", namedCurve: "P-256" },
          true,
          ["deriveBits"]
        )
    );

    if (!("privateKey" in agreementKey)) {
      return yield* Effect.die("ECDH fixture expected a key pair");
    }

    const signing = yield* Effect.promise(
      async () => await crypto.subtle.exportKey("jwk", key)
    );

    const agreement = yield* Effect.promise(
      async () => await crypto.subtle.exportKey("jwk", agreementKey.privateKey)
    );

    const identity = yield* Schema.decodeUnknownEffect(Identity)({
      agreement,
      did,
      signing,
    });

    const id = `${did}#encryption`;

    return {
      did,
      document: {
        ...document,
        keyAgreement: [id],
        verificationMethod: [
          ...document.verificationMethod,
          {
            controller: did,
            id,
            publicKeyJwk: {
              crv: "P-256" as const,
              kty: "EC" as const,
              x: identity.agreement.x,
              y: identity.agreement.y,
            },
          },
        ],
      },
      own: yield* ownIdentity(identity),
    };
  }
);

it.effect(
  "opens sealed operator data before Postbox routes and acknowledges the wake",
  () =>
    Effect.gen(function* sealedRecord() {
      const sender = yield* mailboxIdentity("operator");
      const recipient = yield* mailboxIdentity("mischief-worker");
      const peers = [sender.document, recipient.document];

      const config = {
        endpoint: "https://mailbox.invalid",
        peers,
        serviceDid: "did:web:mailbox.invalid",
      };

      const writer = yield* prepare({ ...config, own: sender.own });
      const reader = yield* prepare({ ...config, own: recipient.own });

      const text = yield* encodePayload({
        body: JSON.stringify({ ...payload, seq: 1 }),
        from: "operator",
        kind: "data",
        summary: "desk wants to wake",
        to: "mischief/worker",
      });

      for (const encrypt of [false, true]) {
        const envelope = yield* writer.seal(recipient.did, text, { encrypt });

        const carrier = yield* readOpened(
          true,
          operator,
          reader.mailbox.open(envelope).pipe(
            Effect.map((opened) => Option.some(inboundOf(opened))),
            Effect.orDie
          )
        );

        expect(carrier.events).toEqual(["wake", "ack", "advance"]);
        expect(carrier.wakes).toMatchObject([
          { messageId: payload.messageId, seq: 1 },
        ]);
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          webCrypto,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() =>
              Effect.die("sealing and opening must not use the network")
            )
          )
        )
      )
    )
);

it.effect(
  "routes only the configured signed sender's typed wake and accepts unknown fields",
  () =>
    Effect.gen(function* authorizedIngress() {
      const sent = yield* read(true, operator, JSON.stringify(payload));
      expect(sent.events).toEqual(["wake", "ack", "advance"]);
      expect(sent.wakes).toEqual([
        {
          $type: payload.$type,
          messageId: payload.messageId,
          name: payload.name,
          recordedAt: payload.recordedAt,
          wake: true,
        },
      ]);

      const impostor = yield* read(
        true,
        "did:web:other.invalid",
        JSON.stringify(payload)
      );

      expect(impostor.events).toEqual(["ack", "advance"]);
      expect(impostor.logs).toMatchObject([
        expect.stringContaining("rejected desk wake"),
      ]);

      const overridden = yield* read(
        true,
        "did:web:other.invalid",
        JSON.stringify({ ...payload, seq: 1 }),
        "did:web:other.invalid"
      );

      expect(overridden.wakes).toMatchObject([{ seq: 1 }]);

      const invalid = yield* read(
        true,
        operator,
        JSON.stringify({ ...payload, name: "sample/desk;id" })
      );

      expect(invalid.events).toEqual(["ack", "advance"]);

      for (const bad of [
        { messageId: "not-a-tid" },
        { recordedAt: "not-a-date" },
        { seq: 0 },
        { seq: Number.MAX_SAFE_INTEGER + 1 },
      ]) {
        const rejected = yield* read(
          true,
          operator,
          JSON.stringify({ ...payload, ...bad })
        );

        expect(rejected.events).toEqual(["ack", "advance"]);
      }
    })
);

it.effect(
  "flag off logs one ignore while unrelated mail takes its existing route",
  () =>
    Effect.gen(function* offAndOther() {
      const off = yield* read(false, operator, JSON.stringify(payload));
      expect(off.events).toEqual(["ack", "advance"]);
      expect(off.logs).toEqual([
        expect.stringContaining("MISCHIEF_DESK_WAKE is off"),
      ]);

      const normal = yield* read(
        true,
        operator,
        "A reply that should reach the existing Postbox route"
      );

      expect(normal.events).toEqual(["normal mail", "ack", "advance"]);

      const unrelated = yield* read(
        true,
        operator,
        JSON.stringify({ ...payload, $type: "unrelated.record" })
      );

      expect(unrelated.events).toEqual(["normal mail", "ack", "advance"]);
    })
);
