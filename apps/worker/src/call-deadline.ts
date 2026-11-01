import { Effect, Schema } from "effect";

const MAILBOX_ATTEMPT_MS = 3000;

const GUARD_MS = 30_000;

const LEASE_POLL_MS = GUARD_MS / 3;

export const DEADLINE_MS = {
  "PlanRun.abortRun": GUARD_MS + LEASE_POLL_MS,
  "PlanRun.deliverReply": GUARD_MS + LEASE_POLL_MS,
  "PlanRun.inspectRun": 10_000,
  "Postbox.aborted": 5000,
  "Postbox.seal": 3 * MAILBOX_ATTEMPT_MS + 1000,
  "Postbox.send": 3 * MAILBOX_ATTEMPT_MS + 1000,
  "Postbox.tallyThink": 5000,
} as const;

export type ObjectCall = keyof typeof DEADLINE_MS;

const POSTBOX_FIX =
  "Next check: look for the Postbox in the celld journal, then probe MISCHIEF_MAILBOX_URL from the celld host";

const RUN_FIX =
  "Next check: inspectRun on that run; a drive holding its lease past the deadline shows as driveLease";

const NEXT: Readonly<Record<ObjectCall, string>> = {
  "PlanRun.abortRun": `The schedule's next alarm asks again. ${RUN_FIX}`,
  "PlanRun.deliverReply": `The reply stays unacked, so the Postbox's next alarm redelivers it. ${RUN_FIX}`,
  "PlanRun.inspectRun": `The schedule's next alarm asks again. ${RUN_FIX}`,
  "Postbox.aborted": `The run's next alarm announces the abort again. ${POSTBOX_FIX}`,
  "Postbox.seal": `The step is held waiting-for-provider and the run's alarm re-drives it. ${POSTBOX_FIX}`,
  "Postbox.send": `The step is held waiting-for-provider and the run's alarm resends the stored envelope. ${POSTBOX_FIX}`,
  "Postbox.tallyThink": `This think goes untallied; the run is unaffected. ${POSTBOX_FIX}`,
};

export class ObjectCallTimedOut extends Schema.TaggedError<ObjectCallTimedOut>()(
  "ObjectCallTimedOut",
  {
    call: Schema.String,
    deadlineMs: Schema.Int,
    next: Schema.String,
  }
) {
  override get message() {
    return `${this.call} got no answer within ${this.deadlineMs} ms, so this turn stopped waiting for it. ${this.next}`;
  }
}

export const withDeadline =
  (call: ObjectCall) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: DEADLINE_MS[call],
        orElse: () =>
          Effect.fail(
            new ObjectCallTimedOut({
              call,
              deadlineMs: DEADLINE_MS[call],
              next: NEXT[call],
            })
          ),
      })
    );
