import {
  DESK_HOST_PORT,
  DeskLease,
  DeskWakeResult,
} from "@mischief/core/desk-wake";
import { Effect, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import type { DeskHost } from "./desk-waker-machine.js";

const request = Effect.fn("deskHostRequest")(function* deskHostRequest<A>(
  key: string | undefined,
  name: string,
  path: "lease" | "wake",
  schema: Schema.Decoder<A>,
  messageId?: string
) {
  if (key === undefined || key.trim() === "") {
    return yield* Effect.fail(
      "MISCHIEF_DESK_WAKE_KEY is empty. Set the matching bearer key on the Worker and desk host."
    );
  }

  const url = `http://127.0.0.1:${DESK_HOST_PORT}/v1/desks/${encodeURIComponent(name)}/${path}`;

  const outgoing =
    messageId === undefined
      ? HttpClientRequest.get(url)
      : HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyJsonUnsafe({ messageId })
        );

  return yield* HttpClient.execute(
    outgoing.pipe(HttpClientRequest.bearerToken(key))
  ).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((body) => ({ body, status: response.status }))
      )
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.mapError(
      () =>
        "Desk host did not answer. Check mischief-desk-host.service, then retry."
    ),
    Effect.timeoutOrElse({
      duration: path === "lease" ? "25 seconds" : "3 minutes",
      orElse: () =>
        Effect.fail(
          "Desk host timed out. Check mischief-desk-host.service and the restore command, then retry."
        ),
    }),
    Effect.flatMap(({ body, status }) =>
      status === 200
        ? Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
            Effect.mapError(
              () =>
                "Desk host returned an invalid receipt. Check mischief-desk-host.service, then retry."
            )
          )
        : Effect.fail(
            `Desk host returned HTTP ${status}. Check mischief-desk-host.service and matching bearer keys, then retry.`
          )
    )
  );
});

export const deskHostClient = (
  key: string | undefined
): DeskHost["Service"] => ({
  leaseLive: (name) =>
    request(key, name, "lease", DeskLease).pipe(
      Effect.result,
      Effect.map((result) => (Result.isSuccess(result) ? result.success : null))
    ),
  wake: (name, messageId) =>
    request(key, name, "wake", DeskWakeResult, messageId).pipe(
      Effect.match({
        onFailure: (reason) =>
          DeskWakeResult.make({ reason, result: "failed" }),
        onSuccess: (receipt) => receipt,
      })
    ),
});
