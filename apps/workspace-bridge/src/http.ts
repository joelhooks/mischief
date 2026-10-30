import { authorized } from "@mischief/model-bridge/auth";
import type { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { sseOf } from "@mischief/model-bridge/protocol";
import { ByteSize, Crypto, Effect, Layer } from "effect";
import type { Redacted } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { Bridge } from "./bridge.js";
import { completeWorkspace } from "./capabilities.js";
import { decodeRequest, refusal } from "./protocol.js";

export const errorResponse = ({ message, retryAfter, status }: BridgeFailure) =>
  HttpServerResponse.jsonUnsafe(
    { error: { message, type: "workspace_bridge_error" } },
    {
      headers:
        retryAfter === undefined ? {} : { "retry-after": String(retryAfter) },
      status,
    }
  );

export const readBody = HttpServerRequest.HttpServerRequest.use((request) =>
  Number(request.headers["content-length"] ?? "0") > 8 * 1024 * 1024
    ? Effect.fail(
        refusal(
          "The request exceeds the 8 MiB body cap. Send a smaller JSON request.",
          413
        )
      )
    : request.text.pipe(
        Effect.provideService(
          HttpIncomingMessage.MaxBodySize,
          ByteSize.mebibytes(8)
        ),
        Effect.mapError(() =>
          refusal(
            "The request exceeds the 8 MiB body cap or could not be read. Send a smaller Responses JSON request.",
            413
          )
        )
      )
);

export const responses = (key: Redacted.Redacted) =>
  Effect.gen(function* respond() {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (!authorized(request.headers.authorization ?? "", key)) {
      return yield* refusal(
        "Bearer authentication failed. Set the same nonempty MISCHIEF_WORKSPACE_BRIDGE_KEY on the bridge and worker.",
        401
      );
    }

    const input = yield* decodeRequest(yield* readBody);
    const completion = yield* completeWorkspace.handler(input);

    return HttpServerResponse.text(
      sseOf(completion, yield* (yield* Crypto.Crypto).randomUUIDv4()),
      {
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
      }
    );
  }).pipe(
    Effect.catchTag("BridgeFailure", (failure) =>
      Effect.succeed(errorResponse(failure))
    )
  );

export const refusedRoute = HttpServerResponse.jsonUnsafe(
  {
    error: {
      message:
        "Only POST /v1/responses is supported. Send a Responses request to that exact method and path.",
    },
  },
  { status: 405 }
);

export const bridgeRoutes = (key: Redacted.Redacted) =>
  Layer.mergeAll(
    HttpRouter.add("POST", "/v1/responses", responses(key)),
    HttpRouter.add(
      "GET",
      "/healthz",
      Bridge.use(({ inFlight }) => inFlight).pipe(
        Effect.map((running) =>
          HttpServerResponse.jsonUnsafe({
            queued: 0,
            running,
            version: "0.1.0",
          })
        )
      )
    ),
    HttpRouter.add("*", "/*", Effect.succeed(refusedRoute))
  );
