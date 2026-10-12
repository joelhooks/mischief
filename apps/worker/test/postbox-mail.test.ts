// @effect-diagnostics asyncFunction:off -- the fake stands in for the Postbox's Promise RPC.
import { expect, it } from "@effect/vitest";
import { Mail } from "@mischief/core";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Option, Schema } from "effect";

import { postboxMail, rememberObject } from "../src/postbox-mail.js";
import type { PostboxRpc } from "../src/postbox-mail.js";

const CALL = { epoch: 0, runId: "gates", visit: 1 };

const OutboxRow = Schema.Struct({ message_id: Schema.String });

const world = () => {
  const storage = nodeSqlStorage(":memory:");
  const calls: string[] = [];

  const rpc: PostboxRpc = {
    seal: async (objectName, to) => {
      calls.push(`seal ${objectName} ${to}`);

      return await Promise.resolve({
        envelope: '{"aad":{},"ciphertext":"AA","enc":"AA"}',
        messageId: "3mxtid",
        ok: true as const,
      });
    },
    send: async (envelope) => {
      calls.push(`send ${envelope.slice(0, 7)}`);

      return await Promise.resolve({ ok: true as const });
    },
  };

  rememberObject(storage, "did:web:driver/gates");

  const outboxIds = () =>
    storage.sql
      .exec("SELECT message_id FROM mischief_outbox")
      .toArray()
      .flatMap((row) =>
        Option.match(Schema.decodeUnknownOption(OutboxRow)(row), {
          onNone: () => [],
          onSome: ({ message_id }) => [message_id],
        })
      );

  return { calls, layer: postboxMail(storage, () => rpc), outboxIds };
};

it.effect(
  "shadow recipients stay record-only, real ones go through the Postbox, and an envelope sealed record-only is never sent as mail",
  () =>
    Effect.gen(function* routed() {
      const { calls, layer, outboxIds } = world();

      yield* Mail.use((mail) =>
        Effect.gen(function* both() {
          const shadow = yield* mail.seal({
            ...CALL,
            key: "land",
            message: "proof?",
            to: "shadow/desk",
          });

          yield* mail.send({ ...CALL, key: "land" }, shadow);

          const real = yield* mail.seal({
            ...CALL,
            key: "ship",
            message: "ship?",
            to: "pi-durable/desk",
          });

          yield* mail.send({ ...CALL, key: "ship" }, real);

          yield* mail.send(
            { ...CALL, key: "old" },
            {
              envelope: '{"message":"sealed before cutover","to":"desk/alpha"}',
              messageId: "gates/old#1",
            }
          );
        })
      ).pipe(Effect.provide(layer));

      expect(calls).toStrictEqual([
        "seal did:web:driver/gates pi-durable/desk",
        'send {"aad":',
      ]);
      expect(outboxIds().toSorted()).toStrictEqual([
        "gates/land#1",
        "gates/old#1",
      ]);
    })
);
