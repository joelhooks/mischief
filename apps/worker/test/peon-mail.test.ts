import { expect, it } from "@effect/vitest";
import { PeonState } from "@mischief/core";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Layer, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { Mailroom, SendVerdict } from "../src/mailroom-port.js";
import { resolvePeonAddress } from "../src/peon-address.js";
import { peonGranted } from "../src/peon-grants.js";
import { peonMatches } from "../src/peon-list.js";
import { peonReplies, receivePeonMail } from "../src/peon-mail.js";
import type { PeonMailHost } from "../src/peon-mail.js";

it.prop(
  "the default listing contains only awake peons and explicit filters reveal sleeping peons and tombstones",
  { state: Arbitrary.schema(PeonState) },
  ({ state }) => {
    const entry = {
      owner: "did:web:driver.example.invalid",
      peonId: "worker-a",
      state,
      template: { name: "full", version: 1 },
      updatedAt: 0,
    };

    expect(peonMatches(entry, {}, entry.owner)).toBe(
      state === "running" || state === "idle"
    );
    expect(peonMatches(entry, { state: "all" }, entry.owner)).toBe(true);
    expect(peonMatches(entry, { state: [state] }, entry.owner)).toBe(true);
    expect(
      peonMatches(entry, { state: "all" }, "did:web:other.example.invalid")
    ).toBe(false);
  }
);

it.effect(
  "mail addresses resolve through JSON, thread and the future instance field without directory entries",
  () =>
    Effect.sync(() => {
      expect(
        resolvePeonAddress(
          undefined,
          '{"peonId":"worker-a","text":"Write the test"}'
        )
      ).toStrictEqual(
        Option.some({ peonId: "worker-a", text: "Write the test" })
      );
      expect(
        resolvePeonAddress(
          undefined,
          '{"thread":"peon:worker-a","body":"Remember the task"}'
        )
      ).toStrictEqual(
        Option.some({ peonId: "worker-a", text: "Remember the task" })
      );
      expect(resolvePeonAddress("peon:worker-a", "Continue")).toStrictEqual(
        Option.some({ peonId: "worker-a", text: "Continue" })
      );
      expect(
        resolvePeonAddress(undefined, "Continue", "worker-a")
      ).toStrictEqual(Option.some({ peonId: "worker-a", text: "Continue" }));
      expect(resolvePeonAddress("peon:../escape", "Continue")).toStrictEqual(
        Option.none()
      );
      expect(
        peonGranted(undefined, "did:web:driver.example.invalid", "promptPeon")
      ).toBe(false);
      expect(
        peonGranted(
          '{"did:web:driver.example.invalid":["promptPeon"]}',
          "did:web:driver.example.invalid",
          "promptPeon"
        )
      ).toBe(true);
      expect(
        peonGranted(
          '{"did:web:driver.example.invalid":["promptPeon"]}',
          "did:web:driver.example.invalid",
          "destroyPeon"
        )
      ).toBe(false);
    })
);

it.effect.prop(
  "mail only wakes a known, owned, authorized live peon and replies to unknown ids and tombstones",
  {
    scenario: Schema.Struct({
      destroyed: Schema.Boolean,
      granted: Schema.Boolean,
      known: Schema.Boolean,
      owned: Schema.Boolean,
    }),
  },
  ({ scenario }) =>
    Effect.gen(function* routing() {
      const message = {
        body: "Continue",
        messageId: "3n2bxr2flu7nf",
        replyTo: Option.none(),
        senderDid: "did:web:driver.example.invalid",
      };

      const accepted: string[] = [];
      const answers: string[] = [];

      const host: PeonMailHost = {
        accept: (peonId, inbound, text) =>
          Effect.sync(() => {
            accepted.push(
              `${peonId}/${inbound.messageId}/${inbound.senderDid}/${text}`
            );
          }),
        enabled: true,
        granted: () => scenario.granted,
        lookup: () =>
          Effect.succeed(
            scenario.known
              ? {
                  destroyedAt: 123,
                  owner: scenario.owned
                    ? message.senderDid
                    : "did:web:other.example.invalid",
                  peonId: "worker-a",
                  state: scenario.destroyed ? "destroyed" : "suspended",
                  template: { name: "full", version: 1 },
                  updatedAt: 123,
                }
              : null
          ),
      };

      const reply = (
        _to: string,
        _messageId: string,
        _peonId: string,
        text: string
      ) =>
        Effect.sync(() => {
          answers.push(text);
        });

      yield* receivePeonMail(
        host,
        message,
        { peonId: "worker-a", text: "Continue" },
        reply
      );

      if (
        scenario.known &&
        scenario.owned &&
        scenario.granted &&
        !scenario.destroyed
      ) {
        expect(accepted).toStrictEqual([
          `worker-a/${message.messageId}/${message.senderDid}/Continue`,
        ]);
        expect(answers).toStrictEqual([]);
      } else {
        expect(accepted).toStrictEqual([]);
        expect(answers).toHaveLength(1);

        if (scenario.known && scenario.owned && scenario.destroyed) {
          expect(answers[0]).toContain("destroyed at 123");
          expect(answers[0]).toContain("full@1");
        }
      }
    })
);

it.effect(
  "a lost mail reply retries the stored sealed bytes on the same thread and treats 409 as done",
  () =>
    Effect.gen(function* replay() {
      const storage = nodeSqlStorage(":memory:");
      let seals = 0;
      const sent: string[] = [];
      const threads: string[] = [];

      const layer = Layer.succeed(
        Mailroom,
        Mailroom.of({
          nameOf: () => Effect.succeed(Option.some("example/desk")),
          seal: () => Effect.die("peon replies must use the reply sealer"),
          sealReply: (_to, messageId, thread) =>
            Effect.sync(() => {
              seals += 1;
              threads.push(`${thread}/${messageId}`);

              return { envelope: `sealed-${seals}`, messageId: "reply-1" };
            }),
          send: (envelope) =>
            Effect.sync(() => {
              sent.push(envelope);

              return sent.length === 1
                ? SendVerdict.cases.Uncertain.make({
                    reason: "connection lost",
                  })
                : SendVerdict.cases.Conflict.make({});
            }),
          surface: () => Effect.void,
          tell: () => Effect.void,
        })
      );

      const reply = () =>
        peonReplies(storage)(
          "did:web:driver.example.invalid",
          "original-1",
          "worker-a",
          "The file is written"
        ).pipe(Effect.provide(layer));

      yield* reply().pipe(Effect.flip);
      yield* reply();
      yield* reply();

      expect(seals).toBe(1);
      expect(sent).toStrictEqual(["sealed-1", "sealed-1"]);
      expect(threads).toStrictEqual(["peon:worker-a/original-1"]);
    }).pipe(Effect.scoped)
);
