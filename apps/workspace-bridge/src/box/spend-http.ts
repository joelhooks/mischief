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
import { SpendLedger } from "./spend-ledger.js";
import {
  ADMIT_PATH,
  RECORD_PATH,
  SpendAdmission,
  SpendPermit,
  SpendProgress,
  SpendReading,
} from "./spend-protocol.js";

const admit = implement(
  defineContract("admitModelSpend", {
    annotations: { idempotent: false, readOnly: false },
    description:
      "Resolve a trusted proxy's socket peer and debit its box before a model call",
    failure: BridgeFailure,
    input: SpendAdmission,
    output: SpendPermit,
  }),
  ({ peer, tokens, outputTokens, requestId }) =>
    Boxes.use(({ ownerAt }) => ownerAt(peer)).pipe(
      Effect.flatMap((owner) =>
        SpendLedger.use((ledger) =>
          ledger.admit(owner, tokens, outputTokens, requestId)
        )
      )
    )
);

const record = implement(
  defineContract("recordModelSpend", {
    annotations: { idempotent: true, readOnly: false },
    description:
      "Record a trusted proxy's cumulative upstream observation against its admitted model call",
    failure: BridgeFailure,
    input: SpendReading,
    output: SpendProgress,
  }),
  (reading) => SpendLedger.use((ledger) => ledger.record(reading))
);

const authenticated = <A, R>(
  key: Redacted.Redacted,
  handle: Effect.Effect<A, BridgeFailure, R>
) =>
  Effect.gen(function* spendRoute() {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (!authorized(request.headers.authorization ?? "", key)) {
      return yield* refusal(
        "Only the host model proxies may write the spend ledger. Configure the manager bearer on the proxy and retry.",
        401
      );
    }

    return yield* handle;
  }).pipe(
    Effect.catchTag("BridgeFailure", (failure) =>
      Effect.succeed(errorResponse(failure))
    )
  );

const invalid = () =>
  refusal(
    "Malformed host spend receipt. Update the model proxy and manager together, then retry."
  );

export const spendRoutes = (key: Redacted.Redacted) =>
  Layer.mergeAll(
    HttpRouter.add(
      "POST",
      ADMIT_PATH,
      authenticated(
        key,
        Effect.gen(function* admitRoute() {
          const input = yield* Schema.decodeEffect(
            Schema.fromJsonString(SpendAdmission)
          )(yield* readBody, { onExcessProperty: "error" }).pipe(
            Effect.mapError(invalid)
          );

          return HttpServerResponse.jsonUnsafe(yield* admit.handler(input));
        })
      )
    ),
    HttpRouter.add(
      "POST",
      RECORD_PATH,
      authenticated(
        key,
        Effect.gen(function* recordRoute() {
          const input = yield* Schema.decodeEffect(
            Schema.fromJsonString(SpendReading)
          )(yield* readBody, { onExcessProperty: "error" }).pipe(
            Effect.mapError(invalid)
          );

          return HttpServerResponse.jsonUnsafe(yield* record.handler(input));
        })
      )
    )
  );
