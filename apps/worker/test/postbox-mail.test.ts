// @effect-diagnostics asyncFunction:off -- the fake stands in for the Postbox's Promise RPC.
import { expect, it } from "@effect/vitest";
import {
  Drive,
  Judge,
  Mail,
  Operator,
  RunHost,
  RunStore,
  Thinker,
} from "@mischief/core";
import { webCrypto } from "@mischief/plan-run";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Fiber, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";

import { DEADLINE_MS } from "../src/call-deadline.js";
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

const askPlan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: ["pi-durable/desk"],
    thresholds: { judge: 0.8 },
  },
  goal: "Ask once",
  id: "asking",
  machine: {
    id: "asking",
    initial: "ask",
    states: {
      ask: {
        meta: {
          step: {
            kind: "ask",
            message: "ready?",
            to: "pi-durable/desk",
            writes: "ready",
          },
        },
        on: { replied: { target: "end" } },
      },
      end: { type: "final" },
    },
  },
};

const unanswered = async <A>(): Promise<A> => {
  await new Response(new ReadableStream()).arrayBuffer();

  return await unanswered<A>();
};

const Stalls = Schema.Literals(["seal", "send"]);

for (const stall of Stalls.literals) {
  it.effect(
    `a Postbox ${stall} that never answers fails the ask at its deadline, holds the run for the alarm, and the alarm's re-drive finishes the ask once the Postbox answers`,
    () =>
      Effect.gen(function* deadline() {
        const storage = nodeSqlStorage(":memory:");
        const calls: string[] = [];
        const postbox = { answering: false };

        const rpc: PostboxRpc = {
          seal: async (_objectName, to) => {
            calls.push(`seal ${to}`);

            if (stall === "seal" && !postbox.answering) {
              return await unanswered();
            }

            return await Promise.resolve({
              envelope: '{"aad":{},"ciphertext":"AA","enc":"AA"}',
              messageId: "3mxtid",
              ok: true as const,
            });
          },
          send: async (envelope) => {
            calls.push(`send ${envelope.slice(0, 7)}`);

            if (stall === "send" && !postbox.answering) {
              return await unanswered();
            }

            return await Promise.resolve({ ok: true as const });
          },
        };

        rememberObject(storage, "did:web:driver/asking");

        const runs = yield* RunHost.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Drive.inline,
              webCrypto,
              postboxMail(storage, () => rpc),
              Judge.unwired,
              Thinker.unwired,
              Layer.succeed(
                Operator,
                Operator.of({
                  held: () => Effect.void,
                  notify: () => Effect.void,
                })
              ),
              Layer.fresh(RunStore.memory)
            )
          )
        );

        const submitted = yield* runs
          .submit("asking", askPlan)
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow.pipe(
          Effect.repeat({
            while: () => !calls.some((entry) => entry.startsWith(stall)),
          })
        );
        yield* TestClock.adjust(DEADLINE_MS[`Postbox.${stall}`] - 1);

        expect(
          submitted.pollUnsafe(),
          "the ask still waits one millisecond before its deadline"
        ).toBeUndefined();

        yield* TestClock.adjust(1);

        const held = yield* Fiber.join(submitted);
        const [hold] = held.held ?? [];

        expect(held.status).toBe("waiting-for-provider");
        expect(held.failures ?? []).toStrictEqual([]);
        expect(hold?.cause).toBe("timeout");
        expect(hold?.provider).toBe("postbox");
        expect(hold?.error).toContain(
          `Postbox.${stall} got no answer within ${DEADLINE_MS[`Postbox.${stall}`]} ms`
        );
        expect(
          hold?.resumeAfter,
          "an automatic resume time arms the run's alarm"
        ).not.toBeNull();

        postbox.answering = true;
        yield* TestClock.setTime(hold?.resumeAfter ?? 0);

        const redriven = yield* runs.advance("asking");

        expect(redriven.status).toBe("waiting-for-reply");
        expect(calls).toStrictEqual(
          stall === "seal"
            ? ["seal pi-durable/desk", "seal pi-durable/desk", 'send {"aad":']
            : ["seal pi-durable/desk", 'send {"aad":', 'send {"aad":']
        );
      })
  );
}
