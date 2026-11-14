import type { PeonIndexEntry } from "@mischief/core";
import type { SqlStorage } from "@mischief/plan-run";
// @effect-diagnostics asyncFunction:off -- Durable Object stubs expose Promise APIs to the Postbox.
import { Effect, Option, Schema } from "effect";

import { Mailroom, SendVerdict } from "./mailroom-port.js";
import type { Inbound } from "./mailroom-port.js";
import { peonGranted } from "./peon-grants.js";
import { PEON_REGISTRY } from "./peon-state.js";
import type { Env } from "./plan-run-object.js";
import { PostboxFailed } from "./postbox-failed.js";

const Envelope = Schema.Struct({
  envelope: Schema.String,
  sent: Schema.Finite,
});

export const peonReplies = (storage: SqlStorage) => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS peon_replies (id TEXT PRIMARY KEY, envelope TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)"
  );

  return Effect.fn("Peon.reply")(function* reply(
    toDid: string,
    messageId: string,
    peonId: string,
    text: string
  ) {
    const [row] = storage.sql
      .exec("SELECT envelope, sent FROM peon_replies WHERE id = ?", messageId)
      .toArray();

    const mailroom = yield* Mailroom;

    const previous =
      row === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(Envelope)(row).pipe(Effect.orDie);

    if (previous?.sent === 1) {
      return yield* Effect.void;
    }

    let envelope = previous?.envelope;

    if (envelope === undefined) {
      const recipient = yield* mailroom.nameOf(toDid);

      if (Option.isNone(recipient) || mailroom.sealReply === undefined) {
        return yield* new PostboxFailed({
          reason: `Peon ${peonId} cannot address a private reply to ${toDid}; no canonical Rat King name or reply sealer is available. Ask the desk to register the caller, then resend the message.`,
        });
      }

      const sealed = yield* mailroom.sealReply(
        recipient.value,
        messageId,
        `peon:${peonId}`,
        `Peon ${peonId}`,
        text
      );

      ({ envelope } = sealed);
      storage.sql.exec(
        "INSERT INTO peon_replies (id, envelope) VALUES (?, ?)",
        messageId,
        envelope
      );
    }

    const verdict = yield* mailroom.send(envelope);

    if (
      SendVerdict.guards.Accepted(verdict) ||
      SendVerdict.guards.Conflict(verdict)
    ) {
      storage.sql.exec(
        "UPDATE peon_replies SET sent = 1 WHERE id = ?",
        messageId
      );

      return yield* Effect.void;
    }

    return yield* new PostboxFailed({
      reason: `Peon ${peonId} reply is not confirmed: ${verdict.reason}. The stored sealed reply remains pending; its Peon alarm retries without resealing.`,
    });
  });
};

export interface PeonMailHost {
  readonly enabled: boolean;
  readonly granted: (sender: string) => boolean;
  readonly lookup: (
    peonId: string
  ) => Effect.Effect<typeof PeonIndexEntry.Type | null, PostboxFailed>;
  readonly accept: (
    peonId: string,
    message: Inbound,
    text: string
  ) => Effect.Effect<void, PostboxFailed>;
}

export const peonMailHost = (env: Env): PeonMailHost => ({
  accept: (peonId, message, text) =>
    Effect.tryPromise({
      catch: (error) =>
        new PostboxFailed({
          reason: `Peon ${peonId} has not accepted this message: ${String(error)}. Leave it unacknowledged; the Postbox retries with the same requestId.`,
        }),
      try: async () => {
        await env.PEON.getByName(peonId).acceptMail(
          message.messageId,
          text,
          message.senderDid
        );
      },
    }),
  enabled: env.MISCHIEF_PEON_BOXES === "on",
  granted: (sender) =>
    peonGranted(env.MISCHIEF_PEON_GRANTS, sender, "promptPeon"),
  lookup: (peonId) =>
    Effect.tryPromise({
      catch: () =>
        new PostboxFailed({
          reason: `The peon registry did not answer for ${peonId}. Leave this message unacknowledged; the Postbox retries it.`,
        }),
      try: async () =>
        await env.PEON_TEMPLATES.getByName(PEON_REGISTRY).lookup(peonId),
    }),
});

export const receivePeonMail = Effect.fn("Peon.receiveMail")(
  function* receivePeonMail<R>(
    host: PeonMailHost,
    message: Inbound,
    address: { readonly peonId: string; readonly text: string },
    reply: (
      to: string,
      messageId: string,
      peonId: string,
      text: string
    ) => Effect.Effect<void, PostboxFailed, R>
  ) {
    const { peonId, text } = address;

    if (!host.enabled) {
      return yield* reply(
        message.senderDid,
        message.messageId,
        peonId,
        "Peon boxes are off; waking a full-tool box would bypass host authorization. Ask the desk to enable MISCHIEF_PEON_BOXES, then resend this message."
      );
    }

    const result = yield* host.lookup(peonId);

    let refusal: string | undefined;

    if (result === null || result.owner !== message.senderDid) {
      refusal = `Unknown peon ${peonId} for this sender. Use listPeons or spawnPeon before sending a prompt.`;
    } else if (result.state === "destroyed") {
      refusal = `Peon ${peonId} was destroyed at ${result.destroyedAt}. Its tombstone names template ${result.template.name}@${result.template.version}; use spawnPeon with a fresh id.`;
    } else if (!host.granted(message.senderDid)) {
      refusal = `Sender has no promptPeon grant; a wake can write files. Ask the desk to grant promptPeon in callers.json, then resend this message.`;
    }

    if (refusal !== undefined) {
      return yield* reply(
        message.senderDid,
        message.messageId,
        peonId,
        refusal
      );
    }

    yield* host.accept(peonId, message, text);

    return yield* Effect.void;
  }
);
