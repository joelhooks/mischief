import { DeskName } from "@mischief/core/desk-wake";
import { PayloadJson, recordType } from "@rat-king/mailbox-client";
import { DateTime, Effect, Option, Schema } from "effect";

import type { Inbound } from "./mailroom-port.js";

const NSID = "sh.mschf.ratking.desk.wake";

const Tid = Schema.String.check(
  Schema.isPattern(
    /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/u
  )
).pipe(Schema.brand("Lexicon:tid"));

const Datetime = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/u
  ),
  Schema.makeFilter((value) => Option.isSome(DateTime.make(value)), {
    expected: "an ISO datetime",
  })
).pipe(Schema.brand("Lexicon:datetime"));

const WakeFields = Schema.Struct({
  $type: Schema.Literal(NSID),
  messageId: Tid,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  recordedAt: Datetime,
  seq: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 })
    )
  ),
  wake: Schema.Literal(true),
});

const DeskWakeRecord = Schema.StructWithRest(WakeFields, [
  Schema.Record(Schema.String, Schema.Json),
]);

export type DeskWake = typeof WakeFields.Encoded;

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(DeskWakeRecord)
);

const isDesk = Schema.is(DeskName);

const payload = Schema.decodeUnknownOption(PayloadJson);

const bodyOf = (body: string) =>
  Option.match(payload(body), {
    onNone: () => body,
    onSome: (opened) => (opened.kind === "data" ? opened.body : body),
  });

export const routeDeskWake = <E, R, E2, R2>(
  message: Inbound,
  enabled: boolean,
  sender: string | undefined,
  wake: (record: DeskWake) => Effect.Effect<void, E, R>,
  otherwise: () => Effect.Effect<void, E2, R2>
): Effect.Effect<void, E | E2, R | R2> => {
  const body = bodyOf(message.body);

  if (recordType(body) !== NSID) {
    return otherwise();
  }

  if (!enabled) {
    return Effect.logInfo(
      "Postbox ignored desk wake: MISCHIEF_DESK_WAKE is off"
    );
  }

  if (sender === undefined || sender === "" || message.senderDid !== sender) {
    return Effect.logWarning(
      "Postbox rejected desk wake: sender is not MISCHIEF_DESK_WAKE_SENDER"
    ).pipe(Effect.annotateLogs({ senderDid: message.senderDid }));
  }

  return Option.match(decode(body), {
    onNone: () =>
      Effect.logWarning(
        "Postbox rejected desk wake: invalid sh.mschf.ratking.desk.wake record"
      ),
    onSome: (record) =>
      isDesk(record.name)
        ? wake(Schema.encodeSync(WakeFields)(record))
        : Effect.logWarning(
            "Postbox rejected desk wake: name is not a safe Rat King project/role"
          ),
  });
};

export const validateDeskWake = (value: DeskWake) =>
  Schema.decodeEffect(
    WakeFields.mapFields((fields) => ({ ...fields, name: DeskName }))
  )(value).pipe(Effect.flatMap(Schema.encodeEffect(WakeFields)));
