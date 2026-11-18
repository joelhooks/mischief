import { defineContract } from "@mischief/capability/contract";
import { implement } from "@mischief/capability/implement";
import {
  DeskLease,
  DeskMessageId,
  DeskName,
  DeskWakeBody,
  DeskWakeResult,
} from "@mischief/core/desk-wake";
import { authorized } from "@mischief/model-bridge/auth";
import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { ByteSize, Effect, Layer, Schema } from "effect";
import type { Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { DeskHost } from "./desk-host.js";
import { errorResponse, readBody } from "./http.js";
import { refusal } from "./protocol.js";

const Name = Schema.Struct({ name: DeskName });

const wake = implement(
  defineContract("wakeDesk", {
    annotations: { idempotent: true, readOnly: false },
    description: "Restore an eligible desk for a triggering message id",
    failure: BridgeFailure,
    input: Schema.Struct({ messageId: DeskMessageId, name: DeskName }),
    output: DeskWakeResult,
  }),
  ({ messageId, name }) => DeskHost.use((host) => host.wake(name, messageId))
);

const lease = implement(
  defineContract("lookupDeskLease", {
    annotations: { idempotent: true, readOnly: true },
    description: "Check the desk's reader lease through Muster",
    failure: BridgeFailure,
    input: Name,
    output: DeskLease,
  }),
  ({ name }) => DeskHost.use((host) => host.lease(name))
);

const route = (key: Redacted.Redacted, method: "GET" | "POST") =>
  Effect.gen(function* deskHostRoute() {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (!authorized(request.headers.authorization ?? "", key)) {
      return yield* refusal(
        "Desk host bearer authentication failed. Set matching nonempty MISCHIEF_DESK_WAKE_KEY values on the Worker and desk host, then retry.",
        401
      );
    }

    const input = yield* HttpRouter.schemaPathParams(Name).pipe(
      Effect.mapError(() =>
        refusal(
          "Invalid desk name. Pass one URL-encoded Rat King project/role name in the path."
        )
      )
    );

    if (method === "GET") {
      return HttpServerResponse.jsonUnsafe(yield* lease.handler(input));
    }

    const body = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(DeskWakeBody)
    )(
      yield* readBody.pipe(
        Effect.provideService(
          HttpServerRequest.MaxBodySize,
          ByteSize.kibibytes(2)
        )
      ),
      { onExcessProperty: "error" }
    ).pipe(
      Effect.mapError(() =>
        refusal(
          "Invalid wake body. POST a JSON object with only the triggering messageId."
        )
      )
    );

    return HttpServerResponse.jsonUnsafe(
      yield* wake.handler({ ...input, ...body })
    );
  }).pipe(
    Effect.catchTag("BridgeFailure", (failure) =>
      Effect.succeed(errorResponse(failure))
    )
  );

export const deskHostRoutes = (key: Redacted.Redacted) =>
  Layer.merge(
    HttpRouter.add("GET", "/v1/desks/:name/lease", route(key, "GET")),
    HttpRouter.add("POST", "/v1/desks/:name/wake", route(key, "POST"))
  );
