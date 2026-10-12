import { Mail } from "@mischief/core";
import { Duration, Effect, Layer, Option, Schema } from "effect";

const HoldSeconds = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 600, minimum: 1 })
);

export const faultHoldSeconds = (raw: string | undefined) =>
  Schema.decodeUnknownOption(HoldSeconds)(raw);

export const faultHold =
  (seconds: Option.Option<number>) =>
  <E, R>(mail: Layer.Layer<Mail, E, R>) =>
    Option.match(seconds, {
      onNone: () => mail,
      onSome: (hold) =>
        Layer.effect(
          Mail,
          Effect.gen(function* heldMail() {
            const inner = yield* Mail;

            return Mail.of({
              ...inner,
              send: (call, sealed) =>
                Effect.logWarning(
                  `fault hold ${sealed.messageId} for ${hold}s`
                ).pipe(
                  Effect.andThen(Effect.sleep(Duration.seconds(hold))),
                  Effect.andThen(
                    Effect.logWarning(`fault release ${sealed.messageId}`)
                  ),
                  Effect.andThen(inner.send(call, sealed))
                ),
            });
          })
        ).pipe(Layer.provide(mail)),
    });
