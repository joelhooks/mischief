// @effect-diagnostics asyncFunction:off -- Durable Object RPC stubs are Promise APIs.
import { Mail, StepFailed } from "@mischief/core";
import { Effect, Layer, Option, Schema } from "effect";

import type { Posted } from "./postbox-object.js";

export interface PostboxRpc {
  readonly seal: (
    objectName: string,
    to: string,
    body: string
  ) => Promise<
    Posted<{ readonly envelope: string; readonly messageId: string }>
  >;
  readonly send: (envelope: string) => Promise<Posted<object>>;
}

const OBJECT =
  "CREATE TABLE IF NOT EXISTS mischief_object (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL)";

export const OBJECT_HEADER = "x-mischief-object";

export const rememberObject = (
  storage: DurableObjectStorage,
  name: string | null
) => {
  storage.sql.exec(OBJECT);

  if (name !== null && name !== "") {
    storage.sql.exec(
      "INSERT INTO mischief_object (id, name) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name",
      name
    );
  }
};

const ObjectRow = Schema.Struct({ name: Schema.String });

const objectOf = (storage: DurableObjectStorage) => {
  storage.sql.exec(OBJECT);

  return Option.fromNullishOr(
    storage.sql
      .exec("SELECT name FROM mischief_object WHERE id = 1")
      .toArray()[0]
  ).pipe(
    Option.flatMap(Schema.decodeUnknownOption(ObjectRow)),
    Option.map(({ name }) => name)
  );
};

const settled = <A extends object>(
  key: string,
  call: () => Promise<Posted<A>>
) =>
  Effect.tryPromise({
    catch: () =>
      new StepFailed({
        key,
        reason:
          "the Postbox did not answer. Resume the run; if it fails again, check the mischief-celld journal for the Postbox",
      }),
    try: call,
  }).pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result)
        : Effect.fail(new StepFailed({ key, reason: result.reason }))
    )
  );

export const postboxMail = (
  storage: DurableObjectStorage,
  postbox: () => PostboxRpc
) =>
  Layer.succeed(
    Mail,
    Mail.of({
      seal: ({ key, message, to }) =>
        Option.match(objectOf(storage), {
          onNone: () =>
            Effect.fail(
              new StepFailed({
                key,
                reason:
                  "this run does not know its object name, so replies could not find it. Resubmit the run through the Worker",
              })
            ),
          onSome: (name) =>
            settled(
              key,
              async () => await postbox().seal(name, to, message)
            ).pipe(
              Effect.map(({ envelope, messageId }) => ({ envelope, messageId }))
            ),
        }),
      send: ({ key }, { envelope }) =>
        settled(key, async () => await postbox().send(envelope)).pipe(
          Effect.asVoid
        ),
    })
  );
