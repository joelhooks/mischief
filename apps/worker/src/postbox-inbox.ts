import { Clock, Effect, Option } from "effect";

import type { Inbound } from "./mailroom-port.js";
import type { PostboxFailed } from "./postbox-failed.js";
import type { HeldLease, LeaseBook } from "./postbox-lease.js";

export const LEASE_TTL_MS = 300_000;

export const LONG_POLL_MS = 20_000;

export const PAGE_LIMIT = 10;

export type Skip = "expired" | "settled" | "unopenable";

export interface Letter {
  readonly ack: Effect.Effect<void, PostboxFailed>;
  readonly deliver: Effect.Effect<Option.Option<Skip>, PostboxFailed>;
  readonly open: Effect.Effect<Option.Option<Inbound>, PostboxFailed>;
}

export interface InboxEvent {
  readonly letter: Option.Option<Letter>;
  readonly seq: number;
}

export interface Inbox {
  readonly acquire: (
    resume: Option.Option<HeldLease>,
    expiresAt: number
  ) => Effect.Effect<HeldLease, PostboxFailed>;
  readonly page: (
    lease: HeldLease,
    afterSeq: number,
    limit: number
  ) => Effect.Effect<readonly InboxEvent[], PostboxFailed>;
  readonly wait: (
    lease: HeldLease,
    afterSeq: number,
    within: number
  ) => Effect.Effect<boolean, PostboxFailed>;
}

export interface Inlet<E, R> {
  readonly advance: (seq: number) => void;
  readonly cursor: () => number;
  readonly leases: LeaseBook;
  readonly receive: (message: Inbound) => Effect.Effect<void, E, R>;
}

export type BatchOutcome = "more" | "idle";

const leaseFor = Effect.fn("postboxLease")(function* postboxLease(
  inbox: Inbox,
  leases: LeaseBook
) {
  const now = yield* Clock.currentTimeMillis;
  const lease = yield* inbox.acquire(leases.held(now), now + LEASE_TTL_MS);
  leases.save(lease);

  return lease;
});

const skipped = (seq: number, reason: Skip) =>
  Effect.logWarning(`Postbox skipped message ${seq}: ${reason}`);

const take = <E, R>(event: InboxEvent, inlet: Inlet<E, R>) =>
  Option.match(event.letter, {
    onNone: () => Effect.void,
    onSome: (letter) =>
      Effect.gen(function* takeLetter() {
        const opened = yield* letter.open;

        if (Option.isNone(opened)) {
          return yield* skipped(event.seq, "unopenable");
        }

        const settled = yield* letter.deliver;

        if (Option.isSome(settled)) {
          return yield* skipped(event.seq, settled.value);
        }

        yield* inlet.receive(opened.value);

        return yield* letter.ack;
      }),
  }).pipe(
    Effect.andThen(
      Effect.sync(() => {
        inlet.advance(event.seq);
      })
    )
  );

export const readBatch = Effect.fn("readPostboxBatch")(function* readBatch<
  E,
  R,
>(inbox: Inbox, inlet: Inlet<E, R>) {
  const lease = yield* leaseFor(inbox, inlet.leases);
  const afterSeq = inlet.cursor();
  const events = yield* inbox.page(lease, afterSeq, PAGE_LIMIT);

  if (events.length === 0) {
    const woken = yield* inbox.wait(lease, afterSeq, LONG_POLL_MS);
    const outcome: BatchOutcome = woken ? "more" : "idle";

    return outcome;
  }

  yield* Effect.forEach(events, (event) => take(event, inlet), {
    discard: true,
  });

  const outcome: BatchOutcome = "more";

  return outcome;
});
