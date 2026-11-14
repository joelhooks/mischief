import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { UnknownRun } from "@mischief/core";
import { Effect, Layer, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { HttpClient, HttpClientResponse } from "effect/http";

import { ClientError, makeClient } from "../src/index.js";
import { freshIdentity } from "./identity-fixture.js";

const host = {
  audience: "did:web:host.example.invalid#mischief",
  endpoint: "https://mischief.example.invalid",
};

const respond = (status: number, body: Schema.Json) =>
  Layer.merge(
    Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json(body, { status }))
        )
      )
    )
  );

it.effect.prop(
  "host refusal reasons survive unchanged for arbitrary text",
  {
    reason: Arbitrary.schema(Schema.String),
  },
  ({ reason }) =>
    Effect.gen(function* refusal() {
      const identity = yield* freshIdentity();
      const client = yield* makeClient(host, identity);

      const result = yield* client
        .inspectRun({ runId: "first-plan" })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);

      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(ClientError);
        expect(result.failure).toMatchObject({
          kind: "refused",
          reason,
          status: 401,
        });
      }
    }).pipe(Effect.provide(respond(401, { error: reason })))
);

it.effect("declared failures keep the worker's type and fields", () =>
  Effect.gen(function* declared() {
    const client = yield* makeClient(host, yield* freshIdentity());

    const failure = yield* client
      .inspectRun({ runId: "missing" })
      .pipe(Effect.flip);

    expect(failure).toBeInstanceOf(UnknownRun);

    expect(failure).toMatchObject({ runId: "missing" });
  }).pipe(
    Effect.provide(
      respond(
        422,
        Schema.encodeSync(UnknownRun)(new UnknownRun({ runId: "missing" }))
      )
    )
  )
);

it.effect(
  "a successful HTTP status cannot smuggle an invalid run report through the boundary",
  () =>
    Effect.gen(function* invalidOutput() {
      const client = yield* makeClient(host, yield* freshIdentity());

      const failure = yield* client
        .inspectRun({ runId: "missing" })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        kind: "protocol",
        status: 200,
      });
    }).pipe(
      Effect.provide(respond(200, { runId: "missing", status: "invented" }))
    )
);

it.effect.prop(
  "origins with credentials never reach the HTTP transport",
  {
    password: Arbitrary.schema(Schema.NonEmptyString),
  },
  ({ password }) =>
    Effect.gen(function* credentials() {
      const endpoint = new URL(host.endpoint);
      endpoint.password = password;
      endpoint.username = "caller";

      const failure = yield* makeClient(
        { ...host, endpoint: endpoint.href },
        yield* freshIdentity()
      ).pipe(Effect.flip);

      expect(failure).toMatchObject({
        kind: "configuration",
      });
      expect(JSON.stringify(failure)).not.toContain(endpoint.href);
    }).pipe(Effect.provide(respond(200, {})))
);
