import { defineContract } from "@mischief/capability/contract";
import { implement } from "@mischief/capability/implement";
import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Context, Effect, Layer, Redacted, Ref, Schema, Stream } from "effect";
import type { Scope } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { errorResponse, readBody } from "./http.js";
import { refusal } from "./protocol.js";
import { collectBytes } from "./runner.js";

const Input = Schema.Struct({
  body: Schema.Record(Schema.String, Schema.Unknown),
  headers: Schema.Record(Schema.String, Schema.String),
  target: Schema.Literals([
    "/v1/responses",
    "/v1/messages",
    "/v1/messages?beta=true",
    "/v1/responses?beta=true",
  ]),
});

const Output = Schema.Struct({
  body: Schema.declare<Stream.Stream<Uint8Array, BridgeFailure>>(
    (value): value is Stream.Stream<Uint8Array, BridgeFailure> =>
      Stream.isStream(value)
  ),
  contentType: Schema.String,
  status: Schema.Int,
});

export interface FullProxyConfig {
  readonly key: Redacted.Redacted;
  readonly models: readonly string[];
  readonly upstream: string;
}

export class FullProxy extends Context.Service<
  FullProxy,
  {
    readonly forward: (
      input: typeof Input.Type
    ) => Effect.Effect<typeof Output.Type, BridgeFailure, Scope.Scope>;
  }
>()("@mischief/workspace-bridge/FullProxy") {
  static readonly layer = (config: FullProxyConfig) =>
    Layer.effect(
      FullProxy,
      Effect.gen(function* makeFullProxy() {
        const client = yield* HttpClient.HttpClient;
        const count = yield* Ref.make(0);

        const endpoint = yield* Effect.try({
          catch: () =>
            refusal(
              "Invalid full proxy upstream URL. Set MISCHIEF_PEON_CLIPROXY_URL to a credential-free HTTP base URL and restart."
            ),
          try: () => new URL(config.upstream),
        });

        if (
          !["http:", "https:"].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash ||
          Redacted.value(config.key).trim() === "" ||
          config.models.length === 0
        ) {
          return yield* refusal(
            "Invalid full proxy configuration could leak credentials or route work nowhere. Set a credential-free HTTP base URL, a nonempty host key and MISCHIEF_PEON_FULL_MODELS, then restart."
          );
        }

        const forward = Effect.fn("FullProxy.forward")(function* forward(
          input: typeof Input.Type
        ) {
          if (
            !Schema.is(Schema.String)(input.body.model) ||
            !config.models.includes(input.body.model)
          ) {
            return yield* refusal(
              `Model is not in MISCHIEF_PEON_FULL_MODELS; unapproved pool use would charge the wrong account. Select one of ${config.models.join(", ")} and retry.`,
              403
            );
          }

          yield* Effect.acquireRelease(
            Effect.gen(function* admit() {
              const admitted = yield* Ref.modify(count, (value) => [
                value < 8,
                value < 8 ? value + 1 : value,
              ]);

              if (!admitted) {
                return yield* refusal(
                  "Eight full proxy streams are already active; more would overload the provider. Retry after a stream finishes.",
                  503
                );
              }

              return yield* Effect.void;
            }),
            () => Ref.update(count, (value) => value - 1)
          );

          const connectionHeaders = (input.headers.connection ?? "")
            .split(",")
            .map((name) => name.trim().toLowerCase());

          const headers = Object.fromEntries(
            Object.entries(input.headers).filter(
              ([name]) =>
                ![
                  "authorization",
                  "x-api-key",
                  "host",
                  "content-length",
                  "connection",
                  "transfer-encoding",
                  "keep-alive",
                  "te",
                  "trailer",
                  "upgrade",
                  "proxy-authorization",
                  ...connectionHeaders,
                ].includes(name.toLowerCase())
            )
          );

          const response = yield* client
            .execute(
              HttpClientRequest.post(
                `${config.upstream.replace(/\/$/u, "")}${input.target}`
              ).pipe(
                HttpClientRequest.setHeaders(headers),
                HttpClientRequest.setHeaders({
                  authorization: `Bearer ${Redacted.value(config.key)}`,
                  "x-api-key": Redacted.value(config.key),
                }),
                HttpClientRequest.bodyJsonUnsafe(input.body)
              )
            )
            .pipe(
              Effect.mapError(() =>
                refusal(
                  "Full proxy upstream is unavailable. Check the host provider and retry the peon prompt.",
                  503
                )
              )
            );

          const contentType =
            response.headers["content-type"] ?? "application/octet-stream";

          if (response.status >= 400) {
            yield* collectBytes(response.stream, 64 * 1024).pipe(
              Effect.mapError(() =>
                refusal(
                  "Upstream error exceeded 64 KiB; returning it could exhaust the host. Inspect provider health and retry.",
                  502
                )
              )
            );

            return {
              body: Stream.make(
                new TextEncoder().encode(
                  JSON.stringify({
                    error: {
                      message: `Provider returned HTTP ${response.status}. Inspect provider health and retry the peon prompt.`,
                    },
                  })
                )
              ),
              contentType: "application/json",
              status: response.status,
            };
          }

          return {
            body: response.stream.pipe(
              Stream.mapError(() =>
                refusal(
                  "Provider stream was interrupted. Inspect the peon session before retrying the prompt.",
                  502
                )
              )
            ),
            contentType,
            status: response.status,
          };
        });

        return FullProxy.of({ forward });
      })
    );
}

const forwardFullModel = implement(
  defineContract("forwardFullModel", {
    annotations: { idempotent: false, readOnly: true },
    description:
      "Forward full peon model requests with host-only provider credentials",
    failure: BridgeFailure,
    input: Input,
    output: Output,
  }),
  (input) => FullProxy.use(({ forward }) => forward(input))
);

const route = Effect.gen(function* fullProxyRoute() {
  const request = yield* HttpServerRequest.HttpServerRequest;

  const target = yield* Schema.decodeUnknownEffect(Input.fields.target)(
    request.url
  ).pipe(
    Effect.mapError(() =>
      refusal(
        "Only POST /v1/messages or /v1/responses with optional ?beta=true is supported. Correct the provider URL and retry."
      )
    )
  );

  const body = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Input.fields.body)
  )(yield* readBody).pipe(
    Effect.mapError(() =>
      refusal(
        "Invalid model JSON could not be forwarded. Send a JSON object containing model and retry."
      )
    )
  );

  const result = yield* forwardFullModel.handler({
    body,
    headers: request.headers,
    target,
  });

  return HttpServerResponse.stream(result.body, {
    contentType: result.contentType,
    status: result.status,
  });
}).pipe(
  Effect.catchTag("BridgeFailure", (failure) =>
    Effect.succeed(errorResponse(failure))
  )
);

export const fullProxyRoutes = Layer.mergeAll(
  HttpRouter.add("POST", "/v1/messages", route),
  HttpRouter.add("POST", "/v1/responses", route),
  HttpRouter.add(
    "*",
    "/*",
    Effect.succeed(
      HttpServerResponse.jsonUnsafe(
        {
          error: {
            message:
              "Unsupported full model route. Send POST /v1/messages or /v1/responses with optional ?beta=true.",
          },
        },
        { status: 405 }
      )
    )
  )
);
