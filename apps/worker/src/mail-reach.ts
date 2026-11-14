import { callerReach, Mail, mailReachReason, StepFailed } from "@mischief/core";
import { Effect, Layer, Option, Schema } from "effect";

import { didFor, nameFor } from "./fleet-names.js";
import { attributeMail } from "./mail-attribution.js";

const Recipient = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ to: Schema.String }),
    Schema.Struct({ aad: Schema.Struct({ recipientDid: Schema.String }) }),
  ])
);

export const reachableMail = (
  objectName: () => Option.Option<string>,
  config: () => string | undefined
) => {
  const identity = (key: string): Effect.Effect<string, StepFailed> =>
    Option.match(objectName(), {
      onNone: () =>
        Effect.fail(
          new StepFailed({
            key,
            reason:
              "this run has no submitting caller identity. Resubmit it through the Worker so mail reach can be checked",
          })
        ),
      onSome: Effect.succeed,
    });

  const check = (
    key: string,
    recipient:
      | { readonly to: string }
      | { readonly aad: { readonly recipientDid: string } }
  ) =>
    identity(key).pipe(
      Effect.flatMap((name) => {
        const did = name.slice(0, name.lastIndexOf("/"));
        const reach = callerReach(did, config());

        const to =
          "to" in recipient
            ? recipient.to
            : (reach.names.find((candidate) =>
                Option.contains(didFor(candidate), recipient.aad.recipientDid)
              ) ??
              Option.getOrElse(
                nameFor(recipient.aad.recipientDid),
                () => recipient.aad.recipientDid
              ));

        const reason = mailReachReason(did, key, to, config());

        return reason === undefined
          ? Effect.succeed(name)
          : Effect.fail(new StepFailed({ key, reason }));
      })
    );

  return Layer.effect(
    Mail,
    Effect.gen(function* checkedMail() {
      const mail = yield* Mail;

      return Mail.of({
        seal: (call) =>
          identity(call.key).pipe(
            Effect.flatMap((name) =>
              mail.seal({ ...call, message: attributeMail(name, call.message) })
            )
          ),
        send: (call, sealed) =>
          Schema.decodeEffect(Recipient)(sealed.envelope).pipe(
            Effect.mapError(
              () =>
                new StepFailed({
                  key: call.key,
                  reason:
                    "the stored mail has no readable recipient, so caller reach cannot be checked. Ask the Mischief desk (pi-durable/desk) to inspect this run's sealed envelope",
                })
            ),
            Effect.flatMap((recipient) => check(call.key, recipient)),
            Effect.andThen(mail.send(call, sealed))
          ),
      });
    })
  );
};
