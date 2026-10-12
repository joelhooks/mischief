import type { SqlStorage } from "@mischief/plan-run";
import { Effect, Option, Schedule, Schema } from "effect";

import { Mailroom, SendVerdict } from "./mailroom-port.js";
import type { Inbound, SendVerdictValue } from "./mailroom-port.js";
import { PostboxFailed } from "./postbox-failed.js";
import { Delivered, Runs } from "./runs-port.js";

const THREADS =
  "CREATE TABLE IF NOT EXISTS postbox_threads (message_id TEXT PRIMARY KEY, run_id TEXT NOT NULL)";

const PARKED =
  "CREATE TABLE IF NOT EXISTS postbox_parked (message_id TEXT PRIMARY KEY, sender TEXT NOT NULL, reason TEXT NOT NULL, body TEXT NOT NULL)";

const DELIVERED =
  "CREATE TABLE IF NOT EXISTS postbox_delivered (message_id TEXT PRIMARY KEY)";

const CURSOR =
  "CREATE TABLE IF NOT EXISTS postbox_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)";

export const OWN_NAME = "mischief/worker";

export const DESK = "pi-durable/desk";

const RunRow = Schema.Struct({ run_id: Schema.String });

const SeqRow = Schema.Struct({ seq: Schema.Number });

const settle = (
  verdict: SendVerdictValue
): Effect.Effect<void, PostboxFailed> =>
  SendVerdict.match(verdict, {
    Accepted: (): Effect.Effect<void, PostboxFailed> => Effect.void,
    Conflict: () => Effect.void,
    Refused: ({ reason }) =>
      Effect.fail(
        new PostboxFailed({
          reason: `the mailbox refused the message: ${reason}`,
        })
      ),
    Uncertain: ({ reason }) =>
      Effect.fail(
        new PostboxFailed({
          reason: `the mailbox did not confirm the message: ${reason}`,
        })
      ),
  });

export const postbox = (storage: SqlStorage) => {
  storage.sql.exec(THREADS);
  storage.sql.exec(PARKED);
  storage.sql.exec(CURSOR);
  storage.sql.exec(DELIVERED);

  const delivered = (messageId: string) =>
    storage.sql
      .exec(
        "SELECT message_id FROM postbox_delivered WHERE message_id = ?",
        messageId
      )
      .toArray().length > 0;

  const runOf = (messageId: string) =>
    Option.fromNullishOr(
      storage.sql
        .exec(
          "SELECT run_id FROM postbox_threads WHERE message_id = ?",
          messageId
        )
        .toArray()[0]
    ).pipe(
      Option.flatMap(Schema.decodeUnknownOption(RunRow)),
      Option.map(({ run_id }) => run_id)
    );

  const park = (message: Inbound, sender: string, reason: string) =>
    Effect.gen(function* parkMessage() {
      const fresh =
        storage.sql
          .exec(
            "INSERT INTO postbox_parked (message_id, sender, reason, body) VALUES (?, ?, ?, ?) ON CONFLICT (message_id) DO NOTHING RETURNING message_id",
            message.messageId,
            sender,
            reason,
            message.body
          )
          .toArray().length > 0;

      if (fresh) {
        yield* Mailroom.use((mailroom) =>
          mailroom.surface(
            `Mischief parked a reply from ${sender}: ${reason}`,
            `Message ${message.messageId} from ${sender} was not delivered to any run: ${reason}. It is kept in the Postbox's postbox_parked table and was acked so the mailbox moves on. Body:\n\n${message.body}`
          )
        );
      }
    });

  const seal = (runId: string, to: string, body: string) =>
    Mailroom.use((mailroom) => mailroom.seal(to, body)).pipe(
      Effect.tap(({ messageId }) =>
        Effect.sync(() => {
          storage.sql.exec(
            "INSERT INTO postbox_threads (message_id, run_id) VALUES (?, ?) ON CONFLICT (message_id) DO NOTHING",
            messageId,
            runId
          );
        })
      )
    );

  const send = (envelope: string) =>
    Mailroom.use((mailroom) => mailroom.send(envelope)).pipe(
      Effect.flatMap(settle),
      Effect.retry({
        schedule: Schedule.exponential("1 second"),
        times: 3,
        while: ({ reason }) => reason.startsWith("the mailbox did not confirm"),
      })
    );

  const receive = (message: Inbound, seq: number) =>
    Effect.gen(function* receiveMessage() {
      const sender = Option.getOrElse(
        yield* Mailroom.use((mailroom) => mailroom.nameOf(message.senderDid)),
        () => message.senderDid
      );

      const runId = message.replyTo.pipe(Option.flatMap(runOf));

      if (delivered(message.messageId)) {
        return;
      }

      if (Option.isNone(runId)) {
        yield* park(
          message,
          sender,
          Option.match(message.replyTo, {
            onNone: () => "it is not a reply to anything Mischief sent",
            onSome: (replyTo) =>
              `it replies to ${replyTo}, which no Mischief run sent`,
          })
        );
      } else {
        const outcome = yield* Runs.use((runs) =>
          runs.deliver(runId.value, {
            body: message.body,
            from: sender,
            messageId: message.messageId,
            replyTo: Option.getOrElse(message.replyTo, () => ""),
          })
        );

        if (Delivered.guards.Refused(outcome)) {
          yield* park(
            message,
            sender,
            `run ${runId.value} refused it: ${outcome.reason}`
          );
        } else {
          storage.sql.exec(
            "INSERT INTO postbox_delivered (message_id) VALUES (?) ON CONFLICT (message_id) DO NOTHING",
            message.messageId
          );
        }
      }

      storage.sql.exec(
        "INSERT INTO postbox_cursor (id, seq) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq",
        seq
      );
    });

  const cursor = () =>
    Option.fromNullishOr(
      storage.sql
        .exec("SELECT seq FROM postbox_cursor WHERE id = 1")
        .toArray()[0]
    ).pipe(
      Option.flatMap(Schema.decodeUnknownOption(SeqRow)),
      Option.match({ onNone: () => 0, onSome: ({ seq }) => seq })
    );

  return { cursor, receive, seal, send };
};
