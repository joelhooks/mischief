// @effect-diagnostics asyncFunction:off -- Worker fetch and Durable Object RPC are Promise boundaries.
import { defineContract } from "@mischief/capability/contract";
import { toHttpApi } from "@mischief/capability/http-api";
import { implement } from "@mischief/capability/implement";
import { DeskInspection, DeskName } from "@mischief/core/desk-wake";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import type { Env } from "./plan-run-object.js";

class InspectFailed extends Schema.TaggedError<
  InspectFailed,
  { readonly brand: unique symbol }
>()("InspectDeskWakeFailed", {
  reason: Schema.String,
}) {}

export const inspectDeskWake = defineContract("inspectDeskWake", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "Read the desk wake state, last message, attempts and next alarm",
  failure: InspectFailed,
  input: Schema.Struct({ name: DeskName }),
  output: DeskInspection,
});

export const serveDeskWake = async (
  request: Request,
  env: Env,
  issuer: string
) => {
  const wakers = env.DESK_WAKER;

  if (env.MISCHIEF_DESK_WAKE !== "on" || wakers === undefined) {
    return Response.json(
      {
        error:
          "Desk wakes are off. Enable MISCHIEF_DESK_WAKE and bind DESK_WAKER before calling inspectDeskWake.",
      },
      { status: 503 }
    );
  }

  if (issuer !== env.MISCHIEF_DESK_WAKE_SENDER) {
    return Response.json(
      {
        error:
          "Desk wake state is private operator data. Call inspectDeskWake as the configured operator.",
      },
      { status: 403 }
    );
  }

  const http = toHttpApi("Mischief desk wakes", [
    implement(inspectDeskWake, ({ name }) =>
      Effect.tryPromise({
        catch: () =>
          new InspectFailed({
            reason:
              "DeskWaker did not answer. Check the celld journal and retry inspectDeskWake.",
          }),
        try: async () => await wakers.getByName(name).inspect(),
      })
    ),
  ]);

  const { dispose, handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(http.api).pipe(
      Layer.provide(http.layer),
      Layer.provide(HttpServer.layerServices)
    ),
    { disableLogger: true }
  );

  try {
    return await handler(request);
  } finally {
    await dispose();
  }
};
