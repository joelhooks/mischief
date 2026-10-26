// @effect-diagnostics-next-line nodeBuiltinImport:off -- The protocol boundary uses Node's audited constant-time byte comparison for bearer authentication.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { ByteSize, Clock, Effect, Layer, Redacted } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { BridgeFailure } from "./bridge-failure.js";
import { Bridge, BRIDGE_VERSION } from "./bridge.js";
import { completeReview } from "./capabilities.js";
import { decodeRequest, sseOf } from "./protocol.js";

export const authorized = (authorization: string, key: Redacted.Redacted) =>
  timingSafeEqual(
    createHash("sha256").update(authorization).digest(),
    createHash("sha256")
      .update(`Bearer ${Redacted.value(key)}`)
      .digest()
  );

const errorResponse = ({ message, retryAfter, status }: BridgeFailure) =>
  HttpServerResponse.jsonUnsafe(
    { error: { message, type: "bridge_error" } },
    {
      headers:
        retryAfter === undefined ? {} : { "retry-after": String(retryAfter) },
      status,
    }
  );

export const responses = (key: Redacted.Redacted) =>
  Effect.gen(function* respond() {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (!authorized(request.headers.authorization ?? "", key)) {
      return yield* new BridgeFailure({
        message:
          "Bearer authentication failed. Configure MISCHIEF_OPUS_BRIDGE_KEY on both the bridge and the worker.",
        status: 401,
      });
    }

    const body = yield* request.text.pipe(
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        ByteSize.mebibytes(8)
      ),
      Effect.mapError(
        () =>
          new BridgeFailure({
            message:
              "The bridge could not read this request within its 8 MiB limit. Send a smaller JSON text request.",
            status: 413,
          })
      )
    );

    const input = yield* decodeRequest(body);
    const start = yield* Clock.currentTimeMillis;
    const completion = yield* completeReview.handler(input);
    const end = yield* Clock.currentTimeMillis;
    yield* Effect.logInfo({
      durationMs: end - start,
      event: "review_completed",
      inputBytes: new TextEncoder().encode(body).byteLength,
      outputTokens: completion.usage.output,
    });

    return HttpServerResponse.text(sseOf(completion, randomUUID()), {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
    });
  }).pipe(
    Effect.catchTag("BridgeFailure", (failure) =>
      Effect.logWarning({
        event: "review_refused",
        status: failure.status,
      }).pipe(Effect.as(errorResponse(failure)))
    )
  );

export const bridgeRoutes = (key: Redacted.Redacted) =>
  Layer.mergeAll(
    HttpRouter.add("POST", "/v1/responses", responses(key)),
    HttpRouter.add(
      "GET",
      "/healthz",
      Bridge.use(({ inFlight }) => inFlight).pipe(
        Effect.map((inFlight) =>
          HttpServerResponse.jsonUnsafe({ inFlight, version: BRIDGE_VERSION })
        )
      )
    )
  );
