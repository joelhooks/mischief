import { describe, expect, it } from "@effect/vitest";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Cause, Clock, Effect, Exit, Fiber, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import { PostboxFailed } from "../src/postbox-failed.js";
import { LEASE_TTL_MS, LONG_POLL_MS, readBatch } from "../src/postbox-inbox.js";
import type { Inbox, InboxEvent, Letter } from "../src/postbox-inbox.js";
import { leaseBook } from "../src/postbox-lease.js";
import type { HeldLease } from "../src/postbox-lease.js";
import { postbox } from "../src/postbox.js";

const DID = "did:web:mischief.worker.pi.ratking-fleet.invalid";

const Step = Schema.Union([
  Schema.Struct({
    mail: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
    receipt: Schema.Boolean,
  }),
  Schema.Struct({ turn: Schema.Literals(["clean", "crash"]) }),
  Schema.Struct({ release: Schema.Literal(true) }),
  Schema.Struct({
    quiet: Schema.Int.check(Schema.isBetween({ maximum: 60_000, minimum: 1 })),
  }),
]);

type InboxStep = typeof Step.Type;

const histories = Arbitrary.array(Arbitrary.schema(Step), { maxLength: 30 });

type MessageState = "pending" | "delivered" | "acked";

interface Listed {
  readonly id: Option.Option<string>;
  readonly seq: number;
}

const mismatch = (call: string) =>
  new PostboxFailed({ reason: `the mailbox ${call} failed (LeaseMismatch)` });

const fakeMailbox = () => {
  const events: Listed[] = [];
  const states = new Map<string, MessageState>();
  const issued: number[] = [];
  const waits: number[] = [];
  let lease: HeldLease | undefined;

  const append = (id: Option.Option<string>) => {
    events.push({ id, seq: events.length + 1 });
  };

  const valid = (held: HeldLease, now: number) =>
    lease !== undefined &&
    lease.leaseId === held.leaseId &&
    lease.generation === held.generation &&
    lease.expiresAt > now;

  const fenced = (held: HeldLease, call: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        valid(held, now) ? Effect.void : Effect.fail(mismatch(call))
      )
    );

  const letter = (id: string, held: HeldLease): Letter => ({
    ack: fenced(held, "ack").pipe(
      Effect.andThen(
        Effect.sync(() => {
          states.set(id, "acked");
        })
      )
    ),
    deliver: fenced(held, "deliver").pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (states.get(id) === "acked") {
            return Option.some("settled" as const);
          }

          states.set(id, "delivered");

          return Option.none();
        })
      )
    ),
    open: Effect.succeedSome({
      body: id,
      messageId: id,
      replyTo: Option.none(),
      senderDid: "did:web:sender",
    }),
  });

  const inbox: Inbox = {
    acquire: (resume, expiresAt) =>
      Effect.gen(function* acquire() {
        const now = yield* Clock.currentTimeMillis;
        const current = lease;

        const resumes = Option.exists(
          resume,
          (fence) =>
            current !== undefined &&
            fence.leaseId === current.leaseId &&
            fence.generation === current.generation
        );

        if (current !== undefined && current.expiresAt > now && !resumes) {
          return yield* new PostboxFailed({
            reason: "the mailbox acquire failed (LeaseHeld)",
          });
        }

        const capped = Math.min(expiresAt, now + LEASE_TTL_MS);

        if (current !== undefined && current.expiresAt > now) {
          lease = { ...current, expiresAt: capped };

          return lease;
        }

        const generation = (current?.generation ?? 0) + 1;
        lease = {
          did: DID,
          expiresAt: capped,
          generation,
          leaseId: `lease-${generation}`,
        };
        issued.push(generation);

        for (const [id, state] of states) {
          if (state === "delivered") {
            append(Option.some(id));
          }
        }

        return lease;
      }),
    page: (held, afterSeq, limit) =>
      Effect.sync(() =>
        events
          .filter(({ seq }) => seq > afterSeq)
          .slice(0, limit)
          .map(({ id, seq }): InboxEvent => ({
            letter: id.pipe(Option.map((messageId) => letter(messageId, held))),
            seq,
          }))
      ),
    wait: (held, afterSeq, within) =>
      fenced(held, "watch").pipe(
        Effect.andThen(
          Effect.sync(() => {
            waits.push(within);

            return events.some(({ seq }) => seq > afterSeq);
          })
        )
      ),
  };

  const release = Effect.gen(function* releaseLease() {
    const now = yield* Clock.currentTimeMillis;

    if (lease !== undefined && lease.expiresAt > now) {
      lease = { ...lease, expiresAt: now };
    }
  });

  const send = (count: number, receipt: boolean) => {
    for (const _message of Array.from({ length: count })) {
      const id = `m${states.size + 1}`;
      states.set(id, "pending");
      append(Option.some(id));
    }

    if (receipt) {
      append(Option.none());
    }
  };

  return {
    acked: () =>
      [...states.entries()].flatMap(([id, state]) =>
        state === "acked" ? [] : [id]
      ),
    generation: () => lease?.generation,
    inbox,
    issued,
    release,
    send,
    sent: () => [...states.keys()],
    waits,
    watermark: () => events.length,
  };
};

const runHistory = Effect.fn("runInboxHistory")(function* runInboxHistory(
  history: readonly InboxStep[]
) {
  const storage = nodeSqlStorage(":memory:");
  const box = postbox(storage);
  const mailbox = fakeMailbox();
  const journal: string[] = [];
  const failures: string[] = [];
  let crash = false;

  const turn = Effect.fn("inboxTurn")(function* inboxTurn() {
    const fiber = yield* readBatch(mailbox.inbox, {
      advance: box.advance,
      cursor: box.cursor,
      leases: leaseBook(storage),
      receive: (message) =>
        Effect.suspend(() => {
          if (!journal.includes(message.messageId)) {
            journal.push(message.messageId);
          }

          if (!crash) {
            return Effect.void;
          }

          crash = false;

          return Effect.interrupt;
        }),
    }).pipe(Effect.forkChild);

    const exit = yield* Fiber.await(fiber);

    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      failures.push(Cause.pretty(exit.cause));
    }

    const outcome = Exit.isSuccess(exit) ? exit.value : "failed";
    yield* TestClock.adjust(outcome === "more" ? 1 : LONG_POLL_MS);

    return outcome;
  });

  for (const step of history) {
    if ("mail" in step) {
      mailbox.send(step.mail, step.receipt);
    } else if ("quiet" in step) {
      yield* TestClock.adjust(step.quiet);
    } else if ("release" in step) {
      yield* mailbox.release;
    } else {
      crash = step.turn === "crash";
      yield* turn();
      crash = false;
    }
  }

  let idle = 0;

  for (const _drain of Array.from({ length: 200 })) {
    if (idle < 2) {
      idle = (yield* turn()) === "idle" ? idle + 1 : 0;
    }
  }

  return { box, failures, journal, mailbox };
});

describe("Postbox inbox batches", () => {
  it.effect.prop(
    "a crash between journaling and ack redelivers across the turn, the journal dedupes it, and every message is acked once drained",
    { history: histories },
    ({ history }) =>
      Effect.gen(function* crashBetweenReceiveAndAck() {
        const { box, failures, journal, mailbox } = yield* runHistory(history);

        expect(
          failures,
          "no turn fails: each turn resumes a held lease and re-acquires a lapsed or released one"
        ).toStrictEqual([]);
        expect(new Set(journal).size, "nothing journaled twice").toBe(
          journal.length
        );
        expect([...journal].toSorted()).toStrictEqual(
          mailbox.sent().toSorted()
        );
        expect(mailbox.acked(), "every message acked").toStrictEqual([]);
        expect(box.cursor(), "the cursor reaches the watermark").toBe(
          mailbox.watermark()
        );
        expect(mailbox.waits.every((within) => within === LONG_POLL_MS)).toBe(
          true
        );
      }),
    { arbitrary: { runs: 200 } }
  );

  it.effect(
    "100 turns at the long-poll cadence keep one lease generation",
    () =>
      Effect.gen(function* hundredTurns() {
        const { failures, mailbox } = yield* runHistory(
          Array.from({ length: 100 }, (_, index): InboxStep =>
            index % 10 === 0
              ? { mail: 1, receipt: index % 20 === 0 }
              : { turn: "clean" }
          )
        );

        expect(failures).toStrictEqual([]);
        expect(mailbox.issued).toStrictEqual([1]);
        expect(mailbox.generation()).toBe(1);
        expect(mailbox.acked()).toStrictEqual([]);
      })
  );
});
