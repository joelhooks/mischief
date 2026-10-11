import { Mail, StepFailed } from "@mischief/core";
import { Effect, Layer, Schema } from "effect";

import type { SqlStorage } from "./sql.js";

const OUTBOX = `CREATE TABLE IF NOT EXISTS mischief_outbox (message_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, envelope TEXT NOT NULL)`;

const EnvelopeText = Schema.fromJsonString(
  Schema.Struct({ message: Schema.String, to: Schema.String })
);

export const mailOutboxSql = (storage: SqlStorage) =>
  Layer.effect(
    Mail,
    Effect.sync(() => {
      storage.sql.exec(OUTBOX);

      return Mail.of({
        seal: ({ key, message, runId, to, visit }) =>
          Schema.encodeEffect(EnvelopeText)({ message, to }).pipe(
            Effect.map((envelope) => ({
              envelope,
              messageId: `${runId}/${key}#${visit}`,
            })),
            Effect.mapError(
              () => new StepFailed({ key, reason: "envelope did not encode" })
            )
          ),
        send: ({ runId }, { envelope, messageId }) =>
          Effect.sync(() => {
            storage.sql.exec(
              "INSERT INTO mischief_outbox (message_id, run_id, envelope) VALUES (?, ?, ?) ON CONFLICT (message_id) DO NOTHING",
              messageId,
              runId,
              envelope
            );
          }),
      });
    })
  );
