import { WatchInspection } from "@mischief/core";
import type { Watch, WatchFiring, WatchState } from "@mischief/core";
import { Schema } from "effect";

import type { CheckResult } from "./watch-check.js";

export const WatchDelivery = Schema.Struct({
  name: Schema.String,
  wake: Schema.Boolean,
  ownerNotice: Schema.Boolean,
  envelope: Schema.optionalKey(Schema.String),
});

const WatchPending = Schema.Struct({
  firing: WatchInspection.fields.firings.value,
  deliveries: Schema.NullOr(Schema.Array(WatchDelivery)),
});

export const WatchCheckpoint = Schema.Struct({
  ...WatchInspection.fields,
  requestHash: Schema.String,
  nextAt: Schema.NullOr(Schema.Finite),
  pending: Schema.NullOr(WatchPending),
});

export type Checkpoint = typeof WatchCheckpoint.Type;

export type Delivery = typeof WatchDelivery.Type;

type Firing = typeof WatchFiring.Type;

type Transition =
  | { readonly type: "tick"; readonly at: number }
  | {
      readonly type: "check";
      readonly at: number;
      readonly result: CheckResult;
      readonly firing: Firing | null;
    }
  | { readonly type: "sent"; readonly at: number }
  | { readonly type: "stop"; readonly state: "done" | "cancelled" };

const intervalMs = (watch: typeof Watch.Type) => watch.intervalSeconds * 1000;

const following = (watch: typeof Watch.Type, at: number) =>
  Math.min(watch.expiresAt, at + intervalMs(watch));

export const newCheckpoint = (
  watch: typeof Watch.Type,
  requestHash: string
): Checkpoint => ({
  watch,
  requestHash,
  cursor: null,
  evidence: [],
  firings: [],
  lastCheck: null,
  nextAt: following(watch, watch.armedAt),
  pending: null,
});

const setState = (
  record: Checkpoint,
  state: typeof WatchState.Type,
  nextAt: number | null
): Checkpoint => ({
  ...record,
  nextAt,
  watch: { ...record.watch, state },
});

export const transitionWatch = (
  record: Checkpoint,
  event: Transition
): Checkpoint => {
  const { watch } = record;

  switch (event.type) {
    case "stop": {
      return record.nextAt === null
        ? record
        : setState({ ...record, pending: null }, event.state, null);
    }

    case "tick": {
      if (watch.state !== "armed" && watch.state !== "checking") {
        return record;
      }

      return event.at >= watch.expiresAt
        ? setState(record, "expired", null)
        : setState(record, "checking", following(watch, event.at));
    }

    case "check": {
      const { at, result, firing } = event;

      const checked = {
        ...record,
        lastCheck: { at, detail: result.detail, outcome: result.outcome },
        evidence:
          result.outcome === "true"
            ? [...record.evidence, { at, text: result.evidence }].slice(-20)
            : record.evidence,
      };

      if (firing !== null) {
        return setState(
          {
            ...checked,
            cursor: firing.cursor,
            pending: { firing, deliveries: null },
          },
          "fired",
          at + 60_000
        );
      }

      return at >= watch.expiresAt
        ? setState(checked, "expired", null)
        : setState(checked, "armed", following(watch, at));
    }

    case "sent": {
      if (record.pending === null) {
        return record;
      }

      const delivered = {
        ...record,
        firings: [...record.firings, record.pending.firing].slice(-20),
        pending: null,
      };

      if (watch.kind === "once") {
        return setState(delivered, "done", null);
      }

      return event.at >= watch.expiresAt
        ? setState(delivered, "expired", null)
        : setState(delivered, "armed", following(watch, event.at));
    }

    default: {
      return event satisfies never;
    }
  }
};
