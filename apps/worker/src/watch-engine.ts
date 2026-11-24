import { WatchSummary } from "@mischief/core";
import type { Watch, WatchDefinition, WatchInspection } from "@mischief/core";
import { Clock, Effect, Option, Result, Schema } from "effect";

import { canonicalName, nameFor, RESERVED } from "./fleet-names.js";
import { hashPeonText } from "./peon-crypto.js";
import type { PostboxFailed } from "./postbox-failed.js";
import { validateHttp, watchRefusal } from "./watch-check.js";
import type { CheckResult } from "./watch-check.js";
import { newCheckpoint, transitionWatch } from "./watch-machine.js";
import type { Checkpoint, Delivery } from "./watch-machine.js";

type WatchValue = typeof Watch.Type;

type Definition = typeof WatchDefinition.Type;

interface WatchPorts {
  readonly load: Effect.Effect<Checkpoint | undefined>;
  readonly save: (checkpoint: Checkpoint) => Effect.Effect<void>;
  readonly seen: (cursor: string) => Effect.Effect<boolean>;
  readonly check: (watch: WatchValue) => Effect.Effect<CheckResult>;
  readonly reserve: (
    name: string,
    at: number,
    key: string
  ) => Effect.Effect<boolean>;
  readonly seal: (
    delivery: Delivery,
    watch: WatchValue,
    text: string,
    messageId: string
  ) => Effect.Effect<string, PostboxFailed>;
  readonly send: (
    delivery: Delivery,
    envelope: string
  ) => Effect.Effect<void, PostboxFailed>;
}

export const validateWatch = (
  definition: Definition,
  allowlist: string | undefined
) => {
  const { condition, intervalSeconds, timeoutSeconds, notify } = definition;

  if (intervalSeconds < 60) {
    return watchRefusal(
      "IntervalTooShort",
      "A durable watch checks at most once per minute. Retry armWatch with intervalSeconds of at least 60."
    );
  }

  if (notify.to.length > 4 || notify.cc.length > 20) {
    return watchRefusal(
      "TooManyTargets",
      "A watch can wake up to 4 names and quietly copy up to 20. Retry armWatch with fewer targets."
    );
  }

  if (
    [...notify.to, ...notify.cc].some(
      (name) => canonicalName(name) === "joel-iphone"
    )
  ) {
    return watchRefusal(
      "BadCondition",
      "A watch cannot address Joel's phone directly. Notify a desk and use message_shitrat for a phone notification that needs Joel."
    );
  }

  if (
    timeoutSeconds <= 0 ||
    !Number.isSafeInteger(timeoutSeconds * 1000) ||
    !Number.isSafeInteger(intervalSeconds * 1000) ||
    notify.to.length + notify.cc.length === 0
  ) {
    return watchRefusal(
      "BadCondition",
      "A watch needs a positive, representable timeout and at least one recipient. Correct timeoutSeconds, intervalSeconds and notify, then retry armWatch."
    );
  }

  if (condition.type === "peon") {
    return condition.expect.state === undefined &&
      condition.expect.pendingClear === undefined
      ? watchRefusal(
          "BadCondition",
          "A peon watch needs an expected state or pendingClear: true. Add a matcher and retry armWatch."
        )
      : null;
  }

  return validateHttp(condition, allowlist);
};

const initialDeliveries = ({
  to,
  cc,
}: WatchValue["notify"]): readonly Delivery[] => {
  const awake = new Set(to.map(canonicalName));

  return [...new Set([...awake, ...cc.map(canonicalName)])].map((name) => ({
    name,
    ownerNotice: false,
    wake: awake.has(name),
  }));
};

const deliveriesFor = (
  ports: WatchPorts,
  watch: WatchValue,
  pending: NonNullable<Checkpoint["pending"]>,
  at: number
) =>
  Effect.gen(function* assignWakeBudget() {
    const { firing } = pending;
    const deliveries: Delivery[] = [];
    const downgraded = new Set(firing.downgraded);

    for (const delivery of pending.deliveries ??
      initialDeliveries(watch.notify)) {
      if (
        delivery.wake &&
        !(yield* ports.reserve(delivery.name, at, firing.messageId))
      ) {
        downgraded.add(delivery.name);
        deliveries.push({ ...delivery, wake: false });
      } else {
        deliveries.push(delivery);
      }
    }

    const owner = nameFor(watch.owner);

    if (
      downgraded.size > firing.downgraded.length &&
      Option.isSome(owner) &&
      owner.value !== "joel-iphone" &&
      !deliveries.some(
        ({ ownerNotice, envelope }) => ownerNotice && envelope === undefined
      )
    ) {
      deliveries.push({ name: owner.value, ownerNotice: true, wake: false });
    }

    return { deliveries, firing: { ...firing, downgraded: [...downgraded] } };
  });

const noticeText = (
  record: Checkpoint,
  delivery: Delivery,
  pending: NonNullable<Checkpoint["pending"]>
) => {
  if (delivery.ownerNotice) {
    return `Watch ${record.watch.watchId} exceeded the daily wake budget for ${pending.firing.downgraded.join(", ")}. Those names received a quiet copy.`;
  }

  return `${record.watch.message.body}\n\nWatch evidence:\n${record.evidence.at(-1)?.text ?? ""}`;
};

const unknownWatch = () =>
  watchRefusal(
    "UnknownWatch",
    "No watch has this id. Call listWatches and retry using an existing watchId."
  );

export const watchEngine = (ports: WatchPorts) => {
  const existing = ports.load.pipe(
    Effect.flatMap((stored) =>
      stored === undefined
        ? Effect.fail(unknownWatch())
        : Effect.succeed(stored)
    )
  );

  const owned = (caller: string) =>
    existing.pipe(
      Effect.flatMap((record) =>
        record.watch.owner === caller || caller === RESERVED.switchboard.did
          ? Effect.succeed(record)
          : Effect.fail(
              watchRefusal(
                "NotOwner",
                "Only the watch owner or Switchboard can inspect or change this watch. Call listWatches to find watches you own."
              )
            )
      )
    );

  const deliver = (checkpoint: Checkpoint) =>
    Effect.gen(function* deliverPending() {
      const { pending } = checkpoint;

      if (pending === null) {
        return;
      }

      const at = yield* Clock.currentTimeMillis;

      const guarded = { ...checkpoint, nextAt: at + 60_000 };
      yield* ports.save(guarded);

      const dispatch = yield* deliveriesFor(
        ports,
        checkpoint.watch,
        pending,
        at
      );

      const armed = { ...guarded, pending: dispatch };
      yield* ports.save(armed);
      const delayed: Delivery[] = [];

      for (const [index, delivery] of dispatch.deliveries.entries()) {
        const rest = dispatch.deliveries.slice(index + 1);

        const sealed =
          delivery.envelope === undefined
            ? yield* ports
                .seal(
                  delivery,
                  checkpoint.watch,
                  noticeText(checkpoint, delivery, dispatch),
                  dispatch.firing.messageId
                )
                .pipe(Effect.result)
            : Result.succeed(delivery.envelope);

        if (Result.isFailure(sealed)) {
          delayed.push(delivery);
          continue;
        }

        const envelope = sealed.success;
        const inFlight = { ...delivery, envelope };
        yield* ports.save({
          ...armed,
          pending: { ...dispatch, deliveries: [...delayed, inFlight, ...rest] },
        });
        const sent = yield* ports.send(delivery, envelope).pipe(Effect.result);

        if (Result.isFailure(sent)) {
          delayed.push(inFlight);
        }

        yield* ports.save({
          ...armed,
          pending: { ...dispatch, deliveries: [...delayed, ...rest] },
        });
      }

      if (delayed.length === 0) {
        yield* ports.save(
          transitionWatch(armed, {
            at: yield* Clock.currentTimeMillis,
            type: "sent",
          })
        );
      }
    });

  const alarm = Effect.gen(function* runAlarm() {
    const record = yield* ports.load;
    const at = yield* Clock.currentTimeMillis;

    if (record?.nextAt === null || record === undefined || record.nextAt > at) {
      return;
    }

    if (record.pending !== null) {
      yield* deliver(record);

      return;
    }

    const checking = transitionWatch(record, { at, type: "tick" });
    yield* ports.save(checking);

    if (checking.watch.state !== "checking") {
      return;
    }

    const result = yield* ports.check(checking.watch);
    const finished = yield* Clock.currentTimeMillis;

    const firing =
      result.outcome === "true" &&
      finished < checking.watch.expiresAt &&
      !(yield* ports.seen(result.cursor))
        ? {
            at: finished,
            cursor: result.cursor,
            messageId: yield* hashPeonText(
              JSON.stringify([checking.watch.watchId, result.cursor])
            ),
            downgraded: [],
          }
        : null;

    const checked = transitionWatch(checking, {
      at: finished,
      result,
      firing,
      type: "check",
    });

    yield* ports.save(checked);

    if (firing !== null) {
      yield* deliver(checked);
    }
  });

  const arm = Effect.fn("Watch.arm")(function* armWatch(
    watchId: string,
    owner: string,
    definition: Definition
  ) {
    const requestHash = yield* hashPeonText(JSON.stringify(definition));
    const previous = yield* ports.load;

    if (previous === undefined) {
      const armedAt = yield* Clock.currentTimeMillis;
      yield* ports.save(
        newCheckpoint(
          {
            ...definition,
            watchId,
            owner,
            armedAt,
            expiresAt: armedAt + definition.timeoutSeconds * 1000,
            state: "armed",
          },
          requestHash
        )
      );
    } else if (
      previous.requestHash !== requestHash ||
      previous.watch.owner !== owner
    ) {
      return yield* watchRefusal(
        "BadCondition",
        "This requestId already armed a different watch. Retry with the original inputs or use a new requestId."
      );
    }

    return { watchId, state: "armed" } as const;
  });

  const stop = (caller: string, state: "done" | "cancelled") =>
    owned(caller).pipe(
      Effect.flatMap((record) => {
        const stopped = transitionWatch(record, { state, type: "stop" });

        return ports
          .save(stopped)
          .pipe(Effect.as({ state: stopped.watch.state }));
      })
    );

  return {
    alarm,
    arm,
    inspect: (caller: string) =>
      owned(caller).pipe(
        Effect.map(
          ({
            watch,
            lastCheck,
            cursor,
            evidence,
            firings,
            pending,
          }): typeof WatchInspection.Type => ({
            watch,
            lastCheck,
            cursor,
            evidence,
            firings:
              pending === null
                ? firings
                : [...firings, pending.firing].slice(-20),
          })
        )
      ),
    stop,
    summary: ports.load.pipe(
      Effect.map((record) =>
        record === undefined
          ? null
          : Schema.decodeSync(WatchSummary)(record.watch)
      )
    ),
  };
};
