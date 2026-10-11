import { Mail, StepFailed } from "@mischief/core";
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect";

const EnvelopeSchema = Schema.fromJsonString(
  Schema.Struct({ message: Schema.String, to: Schema.String })
);

export const mailOutbox = (root: string) =>
  Layer.effect(
    Mail,
    Effect.gen(function* makeMailOutbox() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outbox = path.join(root, "__outbox.jsonl");

      return Mail.of({
        seal: ({ key, message, runId, to, visit }) =>
          Schema.encodeEffect(EnvelopeSchema)({ message, to }).pipe(
            Effect.map((envelope) => ({
              envelope,
              messageId: `${runId}/${key}#${visit}`,
            })),
            Effect.mapError(
              () => new StepFailed({ key, reason: "envelope did not encode" })
            )
          ),
        send: ({ key }, { envelope, messageId }) =>
          Effect.gen(function* sendToOutbox() {
            const { message, to } =
              yield* Schema.decodeEffect(EnvelopeSchema)(envelope);

            yield* fs.makeDirectory(root, { recursive: true });
            yield* fs.writeFileString(
              outbox,
              `${JSON.stringify({ envelope, messageId, to })}\n`,
              { flag: "a" }
            );
            yield* Console.error(
              `✉️  ${to} is asked: ${message}\n   answer with: mischief deliverReply --replyTo '${messageId}' --from '${to}' --body '<reply>'`
            );
          }).pipe(
            Effect.mapError(
              () =>
                new StepFailed({
                  key,
                  reason: `could not write the outbox at ${outbox}`,
                })
            )
          ),
      });
    })
  );
