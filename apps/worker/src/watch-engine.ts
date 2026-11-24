import { WatchSummary } from "@mischief/core";
import type { Watch, WatchDefinition, WatchInspection } from "@mischief/core";
import { Clock, Effect, Option, Result, Schema } from "effect";

import { canonicalName, nameFor, RESERVED } from "./fleet-names.js";
import { hashPeonText } from "./peon-crypto.js";
import { PostboxFailed } from "./postbox-failed.js";
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
    summary: string,
    text: string,
    messageId: string
  ) => Effect.Effect<string, PostboxFailed>;
  readonly send: (
    delivery: Delivery,
    envelope: string,
    deadline: number
  ) => Effect.Effect<"accepted" | "refused" | "uncertain", PostboxFailed>;
}

const MAX_ATTEMPTS = 6;

const retryDelay = (attempts: number) => 5000 * 2 ** (attempts - 1);

const undelivered = (
  firing: (typeof WatchInspection.Type.firings)[number],
  names: readonly string[]
) => ({
  ...firing,
  undelivered: [...new Set([...(firing.undelivered ?? []), ...names])],
});

const recipientNames = (deliveries: readonly Delivery[]) =>
  deliveries.flatMap(({ name, ownerNotice }) => (ownerNotice ? [] : [name]));

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

  const expire = (checkpoint: Checkpoint, at: number) =>
    Effect.gen(function* expireWatch() {
      const { pending, watch } = checkpoint;

      const firing =
        pending === null
          ? null
          : undelivered(
              pending.firing,
              recipientNames(
                pending.deliveries ?? initialDeliveries(watch.notify)
              )
            );

      yield* ports.save(
        transitionWatch(checkpoint, { type: "expire", firing })
      );
      const owner = nameFor(watch.owner);
      const remaining = firing?.undelivered ?? [];

      if (
        firing !== null &&
        remaining.length > 0 &&
        Option.isSome(owner) &&
        owner.value !== "joel-iphone"
      ) {
        const delivery = { name: owner.value, ownerNotice: true, wake: false };
        yield* ports
          .seal(
            delivery,
            "Watch expired",
            `Watch ${watch.watchId} expired with undelivered recipients: ${remaining.join(", ")}.`,
            firing.messageId
          )
          .pipe(
            Effect.flatMap((envelope) =>
              ports.send(delivery, envelope, at + 10_000)
            ),
            Effect.timeoutOption(10_000),
            Effect.ignore
          );
      }
    });

  const deliver = (checkpoint: Checkpoint) =>
    Effect.gen(function* deliverPending() {
      const { pending } = checkpoint;

      if (pending === null) {
        return;
      }

      const at = yield* Clock.currentTimeMillis;

      const { expiresAt } = checkpoint.watch;

      if (at >= expiresAt) {
        yield* expire(checkpoint, at);

        return;
      }

      const guarded = {
        ...checkpoint,
        nextAt: Math.min(expiresAt, at + 5000),
      };

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

      let {
        firing,
      }: { firing: (typeof WatchInspection.Type.firings)[number] } = dispatch;

      let latest: Checkpoint = armed;

      const savePending = (deliveries: readonly Delivery[], nextAt: number) => {
        latest = { ...armed, nextAt, pending: { firing, deliveries } };

        return ports.save(latest);
      };

      for (const [index, delivery] of dispatch.deliveries.entries()) {
        const now = yield* Clock.currentTimeMillis;

        if (now >= expiresAt) {
          yield* expire(latest, now);

          return;
        }

        const rest = dispatch.deliveries.slice(index + 1);
        const attempts = (delivery.attempts ?? 0) + 1;

        if (attempts > MAX_ATTEMPTS) {
          firing = undelivered(firing, recipientNames([delivery]));
          yield* savePending([...delayed, ...rest], guarded.nextAt);
          continue;
        }

        const inFlight = { ...delivery, attempts };
        yield* savePending([...delayed, inFlight, ...rest], guarded.nextAt);

        const sealed =
          delivery.envelope === undefined
            ? yield* ports
                .seal(
                  delivery,
                  delivery.ownerNotice
                    ? "Watch wake budget exceeded"
                    : checkpoint.watch.message.summary,
                  noticeText(checkpoint, delivery, dispatch),
                  dispatch.firing.messageId
                )
                .pipe(
                  Effect.timeoutOrElse({
                    duration: expiresAt - now,
                    orElse: () =>
                      Effect.fail(
                        new PostboxFailed({
                          reason: "Watch expired while sealing mail",
                        })
                      ),
                  }),
                  Effect.result
                )
            : Result.succeed(delivery.envelope);

        const beforeSend = yield* Clock.currentTimeMillis;

        if (beforeSend >= expiresAt) {
          yield* expire(latest, beforeSend);

          return;
        }

        const sealedDelivery = Result.isFailure(sealed)
          ? inFlight
          : { ...inFlight, envelope: sealed.success };

        let outcome: "accepted" | "refused" | "uncertain" = "uncertain";

        if (Result.isSuccess(sealed)) {
          yield* savePending(
            [...delayed, sealedDelivery, ...rest],
            guarded.nextAt
          );
          const remaining = expiresAt - (yield* Clock.currentTimeMillis);

          if (remaining <= 0) {
            yield* expire(latest, expiresAt);

            return;
          }

          outcome = yield* ports
            .send(sealedDelivery, sealed.success, expiresAt)
            .pipe(
              Effect.orElseSucceed(() => "uncertain" as const),
              Effect.timeoutOrElse({
                duration: remaining,
                orElse: () => Effect.succeed("uncertain" as const),
              })
            );
        }

        if (outcome === "uncertain" && attempts < MAX_ATTEMPTS) {
          delayed.push(sealedDelivery);
        } else if (outcome !== "accepted") {
          firing = undelivered(firing, recipientNames([delivery]));
        }

        yield* savePending([...delayed, ...rest], guarded.nextAt);
      }

      const finished = yield* Clock.currentTimeMillis;

      if (finished >= expiresAt) {
        yield* expire(latest, finished);
      } else if (delayed.length === 0) {
        yield* ports.save(
          transitionWatch(latest, { at: finished, type: "sent" })
        );
      } else {
        const backoff = Math.max(
          ...delayed.map(({ attempts }) => retryDelay(attempts ?? 1))
        );

        yield* savePending(delayed, Math.min(expiresAt, finished + backoff));
      }
    });

  const alarm = Effect.gen(function* runAlarm() {
    const record = yield* ports.load;
    const at = yield* Clock.currentTimeMillis;

    if (record?.nextAt === null || record === undefined || record.nextAt > at) {
      return;
    }

    if (at >= record.watch.expiresAt) {
      yield* expire(record, at);

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
