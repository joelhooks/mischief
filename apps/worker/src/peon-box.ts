import { PeonRefused } from "@mischief/core";
import type { PeonTemplate } from "@mischief/core";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export type PeonBoxOperation =
  | "spawn"
  | "prompt"
  | "suspend"
  | "resume"
  | "hibernate"
  | "clone"
  | "destroy"
  | "inspect";

export interface PeonBoxRequest {
  readonly requestId: string;
  readonly peonId?: string;
  readonly newPeonId?: string;
  readonly text?: string;
  readonly template?: {
    readonly model: string;
    readonly thinking: string;
    readonly tools: "all";
    readonly warm: (typeof PeonTemplate.Type)["warm"];
    readonly limits: (typeof PeonTemplate.Type)["limits"];
    readonly workspace: (typeof PeonTemplate.Type)["workspace"];
    readonly system: string | undefined;
  };
}

const methodOf = (operation: PeonBoxOperation): "GET" | "DELETE" | "POST" => {
  if (operation === "inspect") {
    return "GET";
  }

  return operation === "destroy" ? "DELETE" : "POST";
};

export interface PeonBox {
  readonly call: <A>(
    peonId: string,
    operation: PeonBoxOperation,
    body: PeonBoxRequest | undefined,
    schema: Schema.Decoder<A>
  ) => Effect.Effect<A, PeonRefused>;
}

export const peonBox = (url: string, key: string): PeonBox => ({
  call: (peonId, operation, body, schema) =>
    Effect.gen(function* callBox() {
      const target =
        operation === "spawn"
          ? "/v1/boxes"
          : `/v1/boxes/${peonId}${operation === "inspect" || operation === "destroy" ? "" : `/${operation}`}`;

      const request = HttpClientRequest.make(methodOf(operation))(
        new URL(target, url).href
      ).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        })
      );

      const response = yield* HttpClient.execute(
        body === undefined
          ? request
          : HttpClientRequest.bodyText(request, JSON.stringify(body))
      ).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
        }),
        Effect.mapError(
          () =>
            new PeonRefused({
              reason: `Box ${peonId} ${operation} lost its connection. The stored operation will retry on its alarm with the same requestId; inspectPeon before retrying.`,
            })
        )
      );

      const text = yield* response.text.pipe(
        Effect.mapError(
          () =>
            new PeonRefused({
              reason: `Box ${peonId} ${operation} returned an incomplete response. Its stored requestId remains pending; inspectPeon before retrying.`,
            })
        )
      );

      if (response.status < 200 || response.status >= 300) {
        return yield* new PeonRefused({
          reason: `Box ${peonId} ${operation} returned HTTP ${response.status}: ${text.slice(0, 1024)}. The stored operation remains pending; inspectPeon before retrying.`,
        });
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
        text
      ).pipe(
        Effect.mapError(
          () =>
            new PeonRefused({
              reason: `Box ${peonId} ${operation} returned data outside the box contract. Its requestId remains pending to prevent duplicate work; inspectPeon and check the box manager version.`,
            })
        )
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
});
