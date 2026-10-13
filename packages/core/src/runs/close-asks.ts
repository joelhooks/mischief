import { Effect, Option, Result, Schema } from "effect";

import { Mail, SealedSchema } from "../steps/mail.js";
import { RunStore } from "./run-store.js";
import type { Awaiting } from "./schema.js";

const SHADOW = "shadow/";

export const closeKey = (messageId: string) => `close:${messageId}`;

export const closeText = (
  runId: string,
  messageId: string,
  supersededBy: string | undefined
) =>
  [
    supersededBy === undefined
      ? `Closed: Mischief run ${runId} was aborted, so ask ${messageId} no longer needs an answer. Please do not reply to it; a reply now is refused.`
      : `Closed: Mischief run ${runId} was superseded by run ${supersededBy}, so ask ${messageId} no longer needs an answer. If ${supersededBy} still needs it, it asks again. Please do not reply to the old ask; a reply now is refused.`,
    "",
    JSON.stringify(
      supersededBy === undefined
        ? { closed: runId, supersedes: messageId }
        : { closed: runId, supersededBy, supersedes: messageId }
    ),
  ].join("\n");

const decodeSealed = Schema.decodeUnknownOption(SealedSchema);

export const closeOpenAsks = (
  runId: string,
  open: readonly Awaiting[],
  supersededBy: string | undefined
) =>
  Effect.gen(function* closeAsks() {
    const store = yield* RunStore;
    const mail = yield* Mail;
    const journal = yield* store.readJournal(runId);

    for (const { messageId, to } of open) {
      const key = closeKey(messageId);

      if (to.startsWith(SHADOW) || journal.has(`done:${key}`)) {
        continue;
      }

      const call = { epoch: 0, key, runId, visit: 1 };

      const stored = decodeSealed(journal.get(`seal:${key}`));

      const sealed = Option.isSome(stored)
        ? Result.succeed(stored.value)
        : yield* Effect.result(
            mail.seal({
              ...call,
              message: closeText(runId, messageId, supersededBy),
              to,
            })
          );

      if (Result.isFailure(sealed)) {
        yield* Effect.logWarning(
          `${runId} could not seal its closing note for ${messageId}: ${sealed.failure.reason}`
        );

        continue;
      }

      if (Option.isNone(stored)) {
        yield* store.writeJournal(runId, `seal:${key}`, { ...sealed.success });
      }

      const sent = yield* Effect.result(mail.send(call, sealed.success));

      yield* store.writeJournal(
        runId,
        `done:${key}`,
        Result.isSuccess(sent)
          ? true
          : { error: `${key} failed`, reason: sent.failure.reason }
      );
    }
  });
