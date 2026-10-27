# Abort notices for reply senders

When a run aborts, Mischief tells each sender whose Rat King reply reached that run that the run ended before it finished. The notice identifies the reply and run, includes the abort reason, says nothing the reply fed carried forward, and asks the sender to reply to the next wake's ask or contact the run's owner.

A reply stays unresolved until its run finishes. Consuming the reply at an ask or using it in downstream steps does not resolve it. Done and failed runs do not send abort notices.

## Stores and writers

The run owns its status and abort reason. `RunHost.abort` commits `abort-reason` with the aborted state before calling the operator. `done:abort-notices` records that the Postbox accepted responsibility for the notices, not that the mailbox delivered them. The existing run alarm retries an unconfirmed handoff, including for a run that was paused before it aborted. The abort still succeeds if the handoff fails.

The Postbox owns delivery receipts and notice delivery:

- `postbox_threads` still maps outbound ask ids to run object names. Routing does not change.
- `postbox_delivered` gains nullable `run_id`, `sender`, and `envelope` columns, plus `notified` with a default of zero. The existing successful-delivery path records the run and sender.
- `postbox_aborted` records each aborted run and its original reason. It also catches a successful delivery receipt arriving after the abort notification.
- A notice's sealed envelope is stored before sending. Retries reuse those bytes. An accepted send or the mailbox's identical-resend conflict marks the receipt notified. Concurrent flushes share one permit.

Setup adds missing columns and creates tables and indexes. It does not rewrite or delete existing rows. Old delivery receipts lack the sender and run, so they remain deduplicated but cannot receive retroactive notices.

The Postbox alarm retries pending notices on every reader turn. Notice failures do not change reply routing, parking, acknowledgement or the run's aborted status. Each read fetches at most one pending receipt with keyset pagination. The run/notified index restricts the join to delivery receipts for aborted runs.

## Proof

`apps/worker/test/abort-notices.model.test.ts` compares generated deliver, advance, resolve, fail, abort and restart histories with an independent model. Every abort is also redelivered. Only deliveries to runs that abort before finishing produce notices. Each reply produces one notice, including after replay and eviction.

Both mutations were applied to production code, tested, and removed:

| Mutation | Caught by | Shrunk input |
| --- | --- | --- |
| Notify only when the delivered id also appears among refused/parked deliveries | History property: expected one notice, got zero | `deliver(run=1, reply=0), abort(run=1)` |
| Remove the `notified = 0` guard | History property: expected one notice, got two | `deliver(run=2, reply=0), abort(run=2)` with the abort redelivered |

The first deduplication plant survived a random sample that did not repeat a relevant abort. Adding mandatory redelivery to each generated abort closed that coverage gap; the plant then failed on the two-event input above.

`abort-notices-delivery.test.ts` generates refusal and crash histories around sending. It checks that retries use one sealed envelope after restarts and concurrent aborts. Its SQLite seam test preserves a legacy receipt and exercises a delivery receipt racing the abort.

`abort-notices.test.ts` runs workerd with the production PlanRun and schedule adapters, real SQLite, and a fake mail transport. A scheduled wake receives a reply, uses it, then waits at a shadow judge. The test pauses the wake and advances its stored wake time past wakeTimeout without changing schedule decisions. The first Postbox handoff fails. The run alarm retries it, and the sender receives one notice with the schedule's original reason. Repeated abortRun calls produce no second notice.

## Build and validation

Build the workspace dependencies before rebuilding the tracked library with `pnpm --filter @mischief/worker build:library`. The worker package's normal build also runs that library step.

Required checks:

```sh
muster-heavy -- env VITEST_MAX_WORKERS=4 pnpm -s turbo run check test build --force --concurrency=1
pnpm exec ultracite check
pnpm exec oxfmt --check .
```

This change adds no flag and does not deploy anything. Notices use the host's existing Rat King wiring. Rolling back the code leaves the additive tables and columns intact; old readers ignore them.
