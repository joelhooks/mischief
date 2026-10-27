import { expect, it } from "@effect/vitest";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Layer, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { Mailroom, SendVerdict } from "../src/mailroom-port.js";
import type { SendVerdictValue } from "../src/mailroom-port.js";
import { postbox } from "../src/postbox.js";
import { Delivered, Runs } from "../src/runs-port.js";

const Interruptions = Schema.Array(
  Schema.Literals(["refused", "crash-before-send", "crash-after-send"])
).check(Schema.isMaxLength(8));

it.effect.prop(
  "abort notice retries reuse the sealed bytes after refusal, crash, eviction and concurrent aborts",
  { interruptions: Arbitrary.schema(Interruptions) },
  ({ interruptions }) =>
    Effect.gen(function* retryHistory() {
      const storage = nodeSqlStorage(":memory:");
      let box = postbox(storage);
      let interruption: (typeof Interruptions.Type)[number] | undefined;
      let seals = 0;
      const attempts: string[] = [];
      const received = new Set<string>();

      const mailroom = Layer.succeed(
        Mailroom,
        Mailroom.of({
          nameOf: () => Effect.succeedSome("sender/desk"),
          seal: (to, body) =>
            Effect.sync(() => {
              seals += 1;

              return { envelope: `${seals}:${to}:${body}`, messageId: "ask" };
            }),
          send: (envelope) =>
            Effect.suspend((): Effect.Effect<SendVerdictValue> => {
              attempts.push(envelope);

              if (interruption === "refused") {
                return Effect.succeed(
                  SendVerdict.cases.Refused.make({
                    reason: "retry after repairing the mailbox",
                  })
                );
              }

              if (interruption === "crash-before-send") {
                return Effect.die("crashed before send");
              }

              received.add(envelope);

              return interruption === "crash-after-send"
                ? Effect.die("crashed after mailbox accepted")
                : Effect.succeed(SendVerdict.cases.Accepted.make({}));
            }),
          surface: () => Effect.void,
          tell: () => Effect.void,
        })
      );

      const runs = Layer.succeed(
        Runs,
        Runs.of({
          deliver: () => Effect.succeed(Delivered.cases.Journaled.make({})),
        })
      );

      yield* box
        .seal("run", "sender/desk", "ask")
        .pipe(Effect.provide(mailroom));
      yield* box
        .receive({
          body: "record",
          messageId: "reply",
          replyTo: Option.some("ask"),
          senderDid: "sender",
        })
        .pipe(Effect.provide(Layer.merge(mailroom, runs)));

      for (const fault of interruptions) {
        interruption = fault;
        yield* Effect.exit(
          box.abort("run", "wakeTimeout").pipe(Effect.provide(mailroom))
        );
        box = postbox(storage);
      }

      interruption = undefined;
      yield* Effect.all(
        [box.abort("run", "wakeTimeout"), box.abort("run", "different reason")],
        { concurrency: "unbounded" }
      ).pipe(Effect.provide(mailroom));
      yield* box.flushAbortNotices.pipe(Effect.provide(mailroom));
      expect(seals).toBe(2);
      expect(new Set(attempts).size).toBe(1);
      expect(received.size).toBe(1);
    })
);

it.effect(
  "legacy delivered rows survive additive setup, and a receipt racing abort is picked up by the watchdog flush",
  () =>
    Effect.gen(function* racingReceipt() {
      const storage = nodeSqlStorage(":memory:");
      storage.sql.exec(
        "CREATE TABLE postbox_delivered (message_id TEXT PRIMARY KEY)"
      );
      storage.sql.exec(
        "INSERT INTO postbox_delivered (message_id) VALUES (?)",
        "legacy"
      );
      const box = postbox(storage);
      const sent: string[] = [];

      const mailroom = Layer.succeed(
        Mailroom,
        Mailroom.of({
          nameOf: () => Effect.succeedSome("sender/desk"),
          seal: (_to, body) =>
            Effect.succeed({ envelope: body, messageId: "ask" }),
          send: (envelope) =>
            Effect.sync(() => {
              sent.push(envelope);

              return SendVerdict.cases.Accepted.make({});
            }),
          surface: () => Effect.void,
          tell: () => Effect.void,
        })
      );

      const runs = Layer.succeed(
        Runs,
        Runs.of({
          deliver: () =>
            Effect.sync(() => {
              box.markAborted("run", "wakeTimeout");

              return Delivered.cases.Journaled.make({});
            }),
        })
      );

      yield* box
        .seal("run", "sender/desk", "ask")
        .pipe(Effect.provide(mailroom));
      yield* box
        .receive({
          body: "record",
          messageId: "reply",
          replyTo: Option.some("ask"),
          senderDid: "sender",
        })
        .pipe(Effect.provide(Layer.merge(mailroom, runs)));
      yield* box.flushAbortNotices.pipe(Effect.provide(mailroom));
      yield* box.abort("run", "retry").pipe(Effect.provide(mailroom));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Your reply reply reached");
      expect(
        storage.sql
          .exec(
            "SELECT message_id FROM postbox_delivered WHERE message_id = ?",
            "legacy"
          )
          .toArray()
      ).toStrictEqual([{ message_id: "legacy" }]);
    })
);
