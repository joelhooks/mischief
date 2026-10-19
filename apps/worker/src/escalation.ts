// @effect-diagnostics asyncFunction:off -- Durable Object RPC stubs are Promise APIs.
import { EscalateToSchema } from "@mischief/core";
import type { Held, QuestionInput, StepFailure } from "@mischief/core";
import type { SqlStorage } from "@mischief/plan-run";
import { Effect, Option, Schema } from "effect";

import type { PostboxRpc } from "./postbox-mail.js";

const TARGET =
  "CREATE TABLE IF NOT EXISTS mischief_escalate_to (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL)";

const SEALED =
  "CREATE TABLE IF NOT EXISTS mischief_escalations (notice TEXT PRIMARY KEY, envelope TEXT NOT NULL, message_id TEXT NOT NULL)";

const HOST_DEFAULT = "";

const SubmitEscalation = Schema.Struct({
  escalateTo: Schema.optionalKey(EscalateToSchema),
});

const decodeSubmit = Schema.decodeUnknownOption(
  Schema.fromJsonString(SubmitEscalation)
);

const TargetRow = Schema.Struct({ name: Schema.String });

const SealedRow = Schema.Struct({
  envelope: Schema.String,
  message_id: Schema.String,
});

export const fixEscalationAtFirstSubmit = (
  storage: SqlStorage,
  body: string
) => {
  storage.sql.exec(TARGET);

  const name = decodeSubmit(body).pipe(
    Option.flatMap(({ escalateTo }) => Option.fromNullishOr(escalateTo)),
    Option.getOrElse((): string => HOST_DEFAULT)
  );

  const inserted = storage.transactionSync(() => {
    const fixed =
      storage.sql
        .exec("SELECT name FROM mischief_escalate_to WHERE id = 1")
        .toArray().length > 0;

    if (!fixed) {
      storage.sql.exec(
        "INSERT INTO mischief_escalate_to (id, name) VALUES (1, ?)",
        name
      );
    }

    return !fixed;
  });

  return () => {
    if (inserted) {
      storage.sql.exec("DELETE FROM mischief_escalate_to WHERE id = 1");
    }
  };
};

export const escalationTargetOf = (storage: SqlStorage) => {
  storage.sql.exec(TARGET);

  return Option.fromNullishOr(
    storage.sql
      .exec("SELECT name FROM mischief_escalate_to WHERE id = 1")
      .toArray()[0]
  ).pipe(
    Option.flatMap(Schema.decodeUnknownOption(TargetRow)),
    Option.map(({ name }) => name),
    Option.filter((name) => name !== HOST_DEFAULT)
  );
};

const isText = Schema.is(Schema.String);

const meaningOf = (criterion: Schema.Json | undefined) =>
  isText(criterion) ? criterion : JSON.stringify(criterion);

export const escalationText = (
  runId: string,
  { criteria, key, options, question, reason }: QuestionInput
) =>
  [
    `Mischief run ${runId} is waiting on a judge that could not decide at state ${key}: ${question}`,
    ...(reason === undefined ? [] : ["", reason]),
    ...(criteria === undefined
      ? []
      : [
          "",
          ...options.map(
            (option) => `- ${option}: ${meaningOf(criteria[option])}`
          ),
        ]),
    "",
    JSON.stringify({ criteria, options, question, reason, runId, state: key }),
    "",
    `Fix: answer it with answerRun {"runId": "${runId}", "reply": "<one of ${options.join(", ")}>"} under the identity that submitted the run. Replying to this message does not answer it.`,
  ].join("\n");

export const holdAlarmText = (
  runId: string,
  held: readonly Held[],
  attempts: number
) =>
  [
    `Mischief run ${runId} exhausted its ${attempts} automatic provider resume attempts and stays waiting-for-provider.`,
    ...held.map(
      ({ error, key, provider, status }) =>
        `State ${key}: ${provider}, HTTP ${status ?? "unknown"}. Last error: ${error === "" ? "not available in this older run" : error}`
    ),
    `Fix the model proxy, then call resumeRun {"runId":"${runId}"} under the identity that submitted the run. The automatic attempt budget will not reset.`,
  ].join("\n");

export const failedText = (runId: string, failures: readonly StepFailure[]) =>
  [
    `Mischief run ${runId} failed${failures[0] === undefined ? "" : ` at ${failures[0].key}`}. It will not continue on its own.`,
    ...failures.map(({ key, reason }) => `${key}: ${reason}`),
    "",
    JSON.stringify({ failures, runId, status: "failed" }),
    "",
    `Fix: inspectRun {"runId":"${runId}"} under the identity that submitted it for the full report, fix the cause, then submit the plan again under a new runId.`,
  ].join("\n");

export const holdAlarmTargets = (text: string | undefined) =>
  [
    ...new Set(
      (text ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
    ),
  ].map((name) => Schema.decodeUnknownSync(EscalateToSchema)(name));

export const heldText = (
  runId: string,
  { cause, key, provider, resumeAfter, since, status }: Held
) =>
  [
    `Mischief run ${runId} is held at state ${key}: its model provider ${provider} is unavailable (${cause}${status === null ? "" : `, HTTP ${status}`}). The run is waiting-for-provider, not failed.`,
    "",
    JSON.stringify({
      cause,
      provider,
      resumeAfter,
      runId,
      since,
      state: key,
      status,
    }),
    ...(resumeAfter === null || cause === "billing"
      ? []
      : [
          `The host will automatically retry no earlier than Unix time ${resumeAfter} ms, through the run's think permit.`,
        ]),
    "",
    cause === "billing"
      ? `Fix: the ${provider} account has a billing hold; tell Joel. Once it is cleared, call resumeRun {"runId": "${runId}"} under the identity that submitted the run.`
      : `Fix: once ${provider} answers again, call resumeRun {"runId": "${runId}"} under the identity that submitted the run.`,
  ].join("\n");

const sealedFor = (storage: SqlStorage, notice: string) =>
  Option.fromNullishOr(
    storage.sql
      .exec(
        "SELECT envelope, message_id FROM mischief_escalations WHERE notice = ?",
        notice
      )
      .toArray()[0]
  ).pipe(Option.flatMap(Schema.decodeUnknownOption(SealedRow)));

const posted = <A extends object>(
  call: () => Promise<
    | ({ readonly ok: true } & A)
    | { readonly ok: false; readonly reason: string }
  >
) =>
  Effect.tryPromise({
    catch: (cause) => `the Postbox did not answer: ${String(cause)}`,
    try: call,
  }).pipe(
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result) : Effect.fail(result.reason)
    )
  );

const sealOnce = (
  storage: SqlStorage,
  postbox: () => Pick<PostboxRpc, "seal">,
  objectName: string,
  to: string,
  text: string,
  notice: string
) =>
  Option.match(sealedFor(storage, notice), {
    onNone: () =>
      posted(async () => await postbox().seal(objectName, to, text)).pipe(
        Effect.map(({ envelope, messageId }) => {
          storage.sql.exec(
            "INSERT INTO mischief_escalations (notice, envelope, message_id) VALUES (?, ?, ?) ON CONFLICT (notice) DO NOTHING",
            notice,
            envelope,
            messageId
          );

          return Option.getOrElse(sealedFor(storage, notice), () => ({
            envelope,
            message_id: messageId,
          }));
        })
      ),
    onSome: Effect.succeed,
  });

export const mailOnce =
  ({
    objectName,
    postbox,
    storage,
  }: {
    readonly objectName: () => Option.Option<string>;
    readonly postbox: () => Pick<PostboxRpc, "seal" | "send">;
    readonly storage: SqlStorage;
  }) =>
  (runId: string, to: string, notice: string, text: string) => {
    storage.sql.exec(SEALED);

    const name = objectName();

    if (Option.isNone(name)) {
      return Effect.void;
    }

    return sealOnce(storage, postbox, name.value, to, text, notice).pipe(
      Effect.flatMap(({ envelope }) =>
        posted(async () => await postbox().send(envelope))
      ),
      Effect.matchEffect({
        onFailure: (reason) =>
          Effect.logWarning(
            `${runId} could not mail ${notice} to ${to}: ${reason}. The run still waits; inspectRun shows why`
          ),
        onSuccess: () => Effect.void,
      })
    );
  };

const mailConfirmed = (
  ports: {
    readonly objectName: () => Option.Option<string>;
    readonly postbox: () => Pick<PostboxRpc, "seal" | "send">;
    readonly storage: SqlStorage;
  },
  runId: string,
  to: string,
  notice: string,
  text: string
) => {
  ports.storage.sql.exec(SEALED);

  return Option.match(ports.objectName(), {
    onNone: () =>
      Effect.fail(
        `${runId} cannot mail ${notice} to ${to}: the run object name is not stored. Check the run object routing, then redeliver its alarm`
      ),
    onSome: (name) =>
      sealOnce(ports.storage, ports.postbox, name, to, text, notice).pipe(
        Effect.flatMap(({ envelope }) =>
          posted(async () => await ports.postbox().send(envelope))
        ),
        Effect.asVoid
      ),
  });
};

export const alarmOnHolds =
  (
    ports: {
      readonly objectName: () => Option.Option<string>;
      readonly postbox: () => Pick<PostboxRpc, "seal" | "send">;
      readonly storage: SqlStorage;
    },
    targets: readonly string[]
  ) =>
  (runId: string, held: readonly Held[], attempts: number, notice: string) =>
    Effect.forEach(
      [
        ...new Set([
          ...targets,
          ...Option.toArray(escalationTargetOf(ports.storage)),
        ]),
      ],
      (to) =>
        mailConfirmed(
          ports,
          runId,
          to,
          `${notice}:${to}`,
          holdAlarmText(runId, held, attempts)
        ),
      { discard: true }
    );

export const escalate =
  (ports: {
    readonly objectName: () => Option.Option<string>;
    readonly postbox: () => Pick<PostboxRpc, "seal" | "send">;
    readonly storage: SqlStorage;
  }) =>
  (runId: string, notice: string, text: string) => {
    ports.storage.sql.exec(SEALED);

    return Option.match(escalationTargetOf(ports.storage), {
      onNone: () => Effect.void,
      onSome: (target) => mailOnce(ports)(runId, target, notice, text),
    });
  };
