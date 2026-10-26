import { AlreadyJournaled, ReplyRefused } from "@mischief/core";
import { Effect, Option, Predicate, Schema } from "effect";

import { PostboxFailed } from "./postbox-failed.js";
import { Delivered } from "./runs-port.js";
import type { DeliveredValue } from "./runs-port.js";

const Outcome = Schema.fromJsonString(
  Schema.Union([AlreadyJournaled, ReplyRefused])
);

export const decodeDelivery = (
  objectName: string,
  status: number,
  body: string
): Effect.Effect<DeliveredValue, PostboxFailed> => {
  if (status === 200) {
    return Effect.succeed(Delivered.cases.Journaled.make({}));
  }

  return Option.match(Schema.decodeUnknownOption(Outcome)(body), {
    onNone: () =>
      Effect.fail(
        new PostboxFailed({
          reason: `run ${objectName} answered HTTP ${status}`,
        })
      ),
    onSome: (outcome) =>
      Effect.succeed(
        Predicate.isTagged(outcome, "AlreadyJournaled")
          ? Delivered.cases.AlreadyJournaled.make({})
          : Delivered.cases.Refused.make({ reason: outcome.reason })
      ),
  });
};
