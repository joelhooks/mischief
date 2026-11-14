import { defineContract } from "@mischief/capability/contract";
import { implement } from "@mischief/capability/implement";
import { authorized } from "@mischief/model-bridge/auth";
import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Effect, Layer, Schema } from "effect";
import type { Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { errorResponse, readBody } from "../http.js";
import { refusal } from "../protocol.js";
import { Boxes } from "./manager.js";
import { Action, Create, PeonId, RequestId, Result } from "./protocol.js";

const createBox = implement(
  defineContract("createBox", {
    annotations: { idempotent: true, readOnly: false },
    description: "Create a full peon box at a pinned workspace revision",
    failure: BridgeFailure,
    input: Create,
    output: Result,
  }),
  (input) => Boxes.use(({ create }) => create(input))
);

const actOnBox = implement(
  defineContract("actOnBox", {
    annotations: { idempotent: true, readOnly: false },
    description: "Prompt, sleep, wake, copy or destroy a full peon box",
    failure: BridgeFailure,
    input: Action,
    output: Result,
  }),
  (input) => Boxes.use(({ act }) => act(input))
);

const inspectBox = implement(
  defineContract("inspectBox", {
    annotations: { idempotent: true, readOnly: true },
    description: "Measure box processes and persistent storage",
    failure: BridgeFailure,
    input: Schema.Struct({ peonId: PeonId }),
    output: Result,
  }),
  ({ peonId }) => Boxes.use(({ inspect }) => inspect(peonId))
);

const Body = Schema.Struct({
  newPeonId: Schema.optionalKey(PeonId),
  requestId: RequestId,
  text: Schema.optionalKey(Schema.String),
});

const route = (key: Redacted.Redacted) =>
  Effect.gen(function* boxRoute() {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (!authorized(request.headers.authorization ?? "", key)) {
      return yield* refusal(
        "Box bearer authentication failed; exposing workspace control would allow arbitrary tool use. Set matching nonempty MISCHIEF_BOX_KEY values on the worker and box manager, then retry.",
        401
      );
    }

    if (request.method === "POST" && request.url === "/v1/boxes") {
      const input = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Create)
      )(yield* readBody, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() =>
          refusal(
            "Invalid create body could select an unsafe workspace or template. POST /v1/boxes with a nonempty requestId of at most 512 characters, peonId and the v1 full template (tools=all, pinned repo/sha, model opus or sol)."
          )
        )
      );

      return HttpServerResponse.jsonUnsafe(yield* createBox.handler(input));
    }

    const match =
      /^\/v1\/boxes\/(?<id>[a-z0-9][a-z0-9-]{0,39})(?:\/(?<action>prompt|suspend|resume|hibernate|clone))?$/u.exec(
        request.url
      )?.groups;

    if (match?.id === undefined) {
      return yield* refusal(
        "Unknown box route. Use POST /v1/boxes, GET or DELETE /v1/boxes/{id}, or POST /v1/boxes/{id}/{prompt,suspend,resume,hibernate,clone}.",
        404
      );
    }

    if (request.method === "GET" && match.action === undefined) {
      return HttpServerResponse.jsonUnsafe(
        yield* inspectBox.handler({ peonId: match.id })
      );
    }

    let action: string | undefined;

    if (request.method === "DELETE" && match.action === undefined) {
      action = "destroy";
    } else if (request.method === "POST") {
      ({ action } = match);
    }

    const decodedAction = yield* Schema.decodeUnknownEffect(
      Action.fields.action
    )(action).pipe(
      Effect.mapError(() =>
        refusal(
          "Unsupported box method; invoking the wrong action could lose a session. Use GET to inspect, DELETE to destroy, or POST with a lifecycle action."
        )
      )
    );

    const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Body))(
      yield* readBody,
      { onExcessProperty: "error" }
    ).pipe(
      Effect.mapError(() =>
        refusal(
          "Invalid box body. Supply a nonempty requestId of at most 512 characters plus text for prompt or newPeonId for clone, then retry the same endpoint."
        )
      )
    );

    return HttpServerResponse.jsonUnsafe(
      yield* actOnBox.handler({
        ...body,
        action: decodedAction,
        peonId: match.id,
      })
    );
  }).pipe(
    Effect.catchTag("BridgeFailure", (failure) =>
      Effect.succeed(errorResponse(failure))
    )
  );

export const boxRoutes = (key: Redacted.Redacted) =>
  Layer.mergeAll(
    HttpRouter.add("*", "/v1/boxes", route(key)),
    HttpRouter.add("*", "/v1/boxes/:peonId", route(key)),
    HttpRouter.add("*", "/v1/boxes/:peonId/:action", route(key))
  );
