import { defineContract } from "@mischief/capability/contract";
import { implement } from "@mischief/capability/implement";
import { BoxTailResult, PeonTailQuery } from "@mischief/core";
import { authorized } from "@mischief/model-bridge/auth";
import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Effect, Layer, Schema } from "effect";
import type { Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { errorResponse, readBody } from "../http.js";
import { refusal } from "../protocol.js";
import { BoxBuildRefused } from "./box-build-refused.js";
import { BoxCapacity } from "./box-capacity.js";
import { BoxImageMissing } from "./box-image-missing.js";
import { CustodyMissing } from "./custody-missing.js";
import { CustodyIncomplete } from "./custody-refusal.js";
import { DestroyInProgress } from "./destroy-in-progress.js";
import { Boxes } from "./manager.js";
import { PromptFailed } from "./prompt-failed.js";
import { Action, ActionBody, Create, PeonId, Result } from "./protocol.js";
import { ReceiptMismatch } from "./receipt-mismatch.js";
import { ReplicaMismatch } from "./replica-mismatch.js";
import { ReplicaPending } from "./replica-pending.js";
import { spendRoutes } from "./spend-http.js";
import { WorkspaceUnlanded } from "./workspace-unlanded.js";

const createBox = implement(
  defineContract("createBox", {
    annotations: { idempotent: true, readOnly: false },
    description: "Create a full peon box at a pinned workspace revision",
    failure: Schema.Union([
      BridgeFailure,
      BoxCapacity,
      BoxBuildRefused,
      BoxImageMissing,
    ]),
    input: Create,
    output: Result,
  }),
  (input) => Boxes.use(({ create }) => create(input))
);

const actOnBox = implement(
  defineContract("actOnBox", {
    annotations: { idempotent: true, readOnly: false },
    description:
      "Prompt, sleep, wake, copy, export history or destroy a full peon box",
    failure: Schema.Union([
      BridgeFailure,
      BoxCapacity,
      BoxBuildRefused,
      BoxImageMissing,
      WorkspaceUnlanded,
      CustodyMissing,
      CustodyIncomplete,
      DestroyInProgress,
      PromptFailed,
      ReceiptMismatch,
      ReplicaMismatch,
      ReplicaPending,
    ]),
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

const TailQuery = Schema.fromJsonString(PeonTailQuery);

const tailBox = implement(
  defineContract("tailBox", {
    annotations: { idempotent: true, readOnly: true },
    description:
      "Summarize recent managed Pi entries from the box home without starting the box",
    failure: BridgeFailure,
    input: Schema.Struct({ peonId: PeonId, ...PeonTailQuery.fields }),
    output: BoxTailResult,
  }),
  ({ peonId, ...query }) => Boxes.use(({ tail }) => tail(peonId, query))
);

const taggedFailure = (
  failure: {
    readonly _tag: string;
    readonly status: number;
    readonly message: string;
  },
  details: Readonly<Record<string, Schema.Json>>
) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      { error: { ...details, code: failure._tag, message: failure.message } },
      { status: failure.status }
    )
  );

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
      /^\/v1\/boxes\/(?<id>[a-z0-9][a-z0-9-]{0,39})(?:\/(?<action>prompt|suspend|resume|hibernate|clone|export|tail))?$/u.exec(
        request.url
      )?.groups;

    if (match?.id === undefined) {
      return yield* refusal(
        "Unknown box route. Use POST /v1/boxes, GET or DELETE /v1/boxes/{id}, or POST /v1/boxes/{id}/{prompt,suspend,resume,hibernate,clone,export,tail}.",
        404
      );
    }

    if (request.method === "GET" && match.action === undefined) {
      return HttpServerResponse.jsonUnsafe(
        yield* inspectBox.handler({ peonId: match.id })
      );
    }

    if (request.method === "POST" && match.action === "tail") {
      const query = yield* Schema.decodeUnknownEffect(TailQuery)(
        yield* readBody,
        { onExcessProperty: "error" }
      ).pipe(
        Effect.mapError(() =>
          refusal(
            "Invalid tail body. Supply only entries (1–200) and sinceId (a cursor from a previous tail response)."
          )
        )
      );

      return HttpServerResponse.jsonUnsafe(
        yield* tailBox.handler({ ...query, peonId: match.id }),
        {
          headers: { "cache-control": "no-store" },
        }
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

    const body = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ActionBody)
    )(yield* readBody, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() =>
        refusal(
          "Invalid box body. Supply a nonempty requestId of at most 512 characters plus text for prompt or newPeonId for clone, then retry the same endpoint."
        )
      )
    );

    if (decodedAction !== "export" && body.requestId === undefined) {
      return yield* refusal(
        "Supply a nonempty requestId for this box lifecycle action."
      );
    }

    return HttpServerResponse.jsonUnsafe(
      yield* actOnBox.handler({
        ...body,
        action: decodedAction,
        peonId: match.id,
      })
    );
  }).pipe(
    Effect.catchTags({
      BridgeFailure: (failure) => Effect.succeed(errorResponse(failure)),
      BoxBuildRefused: (failure) =>
        taggedFailure(
          failure,
          failure.state === undefined ? {} : { state: failure.state }
        ),
      BoxImageMissing: (failure) =>
        taggedFailure(failure, { state: failure.state }),
      BoxCapacity: (failure) =>
        taggedFailure(failure, { state: failure.state }),
      WorkspaceUnlanded: (failure) =>
        taggedFailure(failure, {
          dirtyPaths: failure.dirtyPaths,
          dirtyTotal: failure.dirtyTotal,
          refs: failure.refs,
        }),
      CustodyIncomplete: (failure) =>
        taggedFailure(failure, { skipped: failure.skipped }),
      CustodyMissing: (failure) => taggedFailure(failure, { dir: failure.dir }),
      DestroyInProgress: (failure) =>
        taggedFailure(failure, {
          requestId: failure.requestId,
          disposition: failure.disposition,
          retained: failure.retained,
        }),
      PromptFailed: (failure) =>
        taggedFailure(
          failure,
          failure.state === undefined ? {} : { state: failure.state }
        ),
      ReplicaPending: (failure) =>
        taggedFailure(failure, { archiveId: failure.archiveId }),
      ReplicaMismatch: (failure) =>
        taggedFailure(failure, { archiveId: failure.archiveId }),
      ReceiptMismatch: (failure) =>
        taggedFailure(failure, { reason: failure.reason }),
    })
  );

export const boxRoutes = (key: Redacted.Redacted) =>
  Layer.mergeAll(
    HttpRouter.add("*", "/v1/boxes", route(key)),
    HttpRouter.add("*", "/v1/boxes/:peonId", route(key)),
    HttpRouter.add("*", "/v1/boxes/:peonId/:action", route(key))
  );

export const boxManagerRoutes = (keys: {
  readonly controlKey: Redacted.Redacted;
  readonly spendKey: Redacted.Redacted;
}) => Layer.merge(boxRoutes(keys.controlKey), spendRoutes(keys.spendKey));
