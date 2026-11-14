import { defineContract } from "@mischief/capability/contract";
import { implement } from "@mischief/capability/implement";
import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import {
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
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

const MessageBody = Schema.Record(Schema.String, Schema.Unknown);

const ClientTools = Schema.Array(
  Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    name: Schema.Literals(["read", "grep", "find", "ls", "bash"]),
    parameters: Schema.Record(Schema.String, Schema.Unknown),
    strict: Schema.optionalKey(Schema.Boolean),
    type: Schema.Literal("function"),
  })
);

const RESPONSE_FIELDS = new Set([
  "model",
  "input",
  "stream",
  "store",
  "max_output_tokens",
  "temperature",
  "service_tier",
  "prompt_cache_key",
  "prompt_cache_retention",
  "reasoning",
  "include",
  "tool_choice",
  "tools",
]);

const PI_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "sec-fetch-mode",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "host",
  "user-agent",
  "session_id",
  "x-client-request-id",
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-os",
  "x-stainless-arch",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-retry-count",
  "x-stainless-timeout",
]);

const ToolChoice = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({
    name: Schema.Literals(["read", "grep", "find", "ls", "bash"]),
    type: Schema.Literal("function"),
  }),
]);

const ResponseOptions = Schema.Struct({
  include: Schema.optionalKey(
    Schema.Tuple([Schema.Literal("reasoning.encrypted_content")])
  ),
  input: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.optionalKey(
          Schema.Literals(["read", "grep", "find", "ls", "bash"])
        ),
        role: Schema.optionalKey(
          Schema.Literals(["system", "developer", "user", "assistant"])
        ),
        type: Schema.optionalKey(
          Schema.Literals([
            "message",
            "function_call",
            "function_call_output",
            "reasoning",
          ])
        ),
      })
    )
  ),
  prompt_cache_key: Schema.optionalKey(Schema.String),
  prompt_cache_retention: Schema.optionalKey(Schema.Literal("24h")),
  reasoning: Schema.optionalKey(
    Schema.Struct({
      effort: Schema.optionalKey(
        Schema.Literals([
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ])
      ),
      summary: Schema.optionalKey(Schema.Literal("auto")),
    })
  ),
  service_tier: Schema.optionalKey(
    Schema.Literals(["auto", "default", "flex", "priority"])
  ),
  store: Schema.optionalKey(Schema.Literal(false)),
  stream: Schema.optionalKey(Schema.Literal(true)),
  temperature: Schema.optionalKey(Schema.Finite),
});

const ProxyInput = Schema.Struct({
  body: MessageBody,
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const ProxyOutput = Schema.Struct({
  body: Schema.declare<Stream.Stream<Uint8Array, BridgeFailure>>(
    (input): input is Stream.Stream<Uint8Array, BridgeFailure> =>
      Stream.isStream(input)
  ),
  contentType: Schema.String,
  status: Schema.Int,
});

const ProviderError = Schema.Struct({
  error: Schema.Struct({ type: Schema.String }),
});

export interface ProxyConfig {
  readonly key: Redacted.Redacted;
  readonly models: readonly string[];
  readonly upstream: string;
}

export class Proxy extends Context.Service<
  Proxy,
  {
    readonly forward: (
      request: typeof ProxyInput.Type
    ) => Effect.Effect<typeof ProxyOutput.Type, BridgeFailure, Scope.Scope>;
  }
>()("@mischief/workspace-bridge/Proxy") {
  static readonly layer = (config: ProxyConfig) =>
    Layer.effect(
      Proxy,
      Effect.gen(function* makeProxy() {
        const client = yield* HttpClient.HttpClient;
        const count = yield* Ref.make(0);

        const models = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Literal("gpt-6.1-sol")).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(1)
          )
        )(config.models).pipe(
          Effect.mapError(() =>
            refusal(
              'MISCHIEF_PEON_MODELS must be ["gpt-6.1-sol"]. Peons use the Codex pool; correct the allowlist and restart the proxy.'
            )
          )
        );

        const endpoint = yield* Effect.try({
          catch: () =>
            refusal(
              "MISCHIEF_PEON_CLIPROXY_URL is not a URL. Configure a credential-free HTTP base URL and restart the proxy."
            ),
          try: () => new URL(config.upstream),
        });

        if (
          !["http:", "https:"].includes(endpoint.protocol) ||
          endpoint.username !== "" ||
          endpoint.password !== "" ||
          endpoint.search !== "" ||
          endpoint.hash !== ""
        ) {
          return yield* refusal(
            "MISCHIEF_PEON_CLIPROXY_URL is not a credential-free HTTP base URL. Configure the dedicated peon Responses provider before starting."
          );
        }

        const upstream = `${config.upstream.replace(/\/$/u, "")}/v1/responses`;

        const forward = Effect.fn("PeonProxy.forward")(function* forward(
          request: typeof ProxyInput.Type
        ) {
          if (
            !Schema.is(Schema.Literal("gpt-6.1-sol"))(request.body.model) ||
            !models.includes(request.body.model)
          ) {
            return yield* refusal(
              `This proxy permits only ${models.join(", ")}. Select peon/gpt-6.1-sol and retry.`,
              403
            );
          }

          if (
            Object.keys(request.body).some((key) => !RESPONSE_FIELDS.has(key))
          ) {
            return yield* refusal(
              "Unsupported Responses field. Hosted tools, previous_response_id and background are not permitted; send only Pi's stateless Responses fields and function tools."
            );
          }

          if (
            Object.keys(request.headers ?? {}).some(
              (key) => !PI_HEADERS.has(key)
            )
          ) {
            return yield* refusal(
              `Unsupported Responses headers: ${Object.keys(
                request.headers ?? {}
              )
                .filter((key) => !PI_HEADERS.has(key))
                .join(
                  ", "
                )}. Provider feature switches are not permitted; remove custom headers and use Pi's openai-responses provider.`,
              403
            );
          }

          yield* Schema.decodeUnknownEffect(ResponseOptions)(request.body).pipe(
            Effect.mapError(() =>
              refusal(
                "Unsupported Pi Responses options or transcript item. Send stateless message, reasoning and Pi function-call history with store=false and stream=true; remove hosted tool history and retry.",
                403
              )
            )
          );

          if (request.body.tool_choice !== undefined) {
            yield* Schema.decodeUnknownEffect(ToolChoice)(
              request.body.tool_choice,
              { onExcessProperty: "error" }
            ).pipe(
              Effect.mapError(() =>
                refusal(
                  "Only auto, none, required or a named Pi function tool_choice is permitted. Remove hosted tool selection and retry.",
                  403
                )
              )
            );
          }

          if (request.body.max_output_tokens !== undefined) {
            yield* Schema.decodeUnknownEffect(
              Schema.Int.check(
                Schema.isBetween({ maximum: 128_000, minimum: 16 })
              )
            )(request.body.max_output_tokens).pipe(
              Effect.mapError(() =>
                refusal(
                  "The peon proxy permits max_output_tokens from 16 through 128000. Correct that per-response ceiling and retry."
                )
              )
            );
          }

          if (request.body.tools !== undefined) {
            yield* Schema.decodeUnknownEffect(ClientTools)(request.body.tools, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(() =>
                refusal(
                  "Only Pi function tools read, grep, find, ls, bash with parameters are permitted. Remove hosted tools and connectors before retrying.",
                  403
                )
              )
            );
          }

          yield* Effect.acquireRelease(
            Effect.gen(function* admit() {
              const admitted = yield* Ref.modify(count, (running) => [
                running < 8,
                running < 8 ? running + 1 : running,
              ]);

              if (!admitted) {
                return yield* refusal(
                  "All eight peon proxy slots are busy. Park this think and retry; the proxy does not queue calls.",
                  503
                );
              }

              return yield* Effect.void;
            }),
            () => Ref.update(count, (running) => running - 1)
          );

          for (const delay of [0, 2000, 4000, 8000]) {
            if (delay > 0) {
              yield* Effect.sleep(delay);
            }

            const response = yield* client
              .execute(
                HttpClientRequest.post(upstream).pipe(
                  HttpClientRequest.setHeaders(
                    Object.fromEntries(
                      Object.entries(request.headers ?? {}).filter(
                        ([key]) =>
                          ![
                            "authorization",
                            "host",
                            "content-length",
                            "connection",
                          ].includes(key)
                      )
                    )
                  ),
                  HttpClientRequest.setHeaders({
                    authorization: `Bearer ${Redacted.value(config.key)}`,
                    "x-cliproxy-client": "mischief/peons",
                  }),
                  HttpClientRequest.bodyJsonUnsafe(request.body)
                )
              )
              .pipe(
                Effect.mapError(() =>
                  refusal(
                    "The peon Responses upstream is unavailable. Check the host proxy provider and resume the think.",
                    503
                  )
                )
              );

            const contentType =
              response.headers["content-type"] ?? "application/octet-stream";

            if (response.status < 400) {
              return {
                body: response.stream.pipe(
                  Stream.mapError(() =>
                    refusal(
                      "The peon Responses stream was interrupted. Check the upstream and resume the think.",
                      503
                    )
                  )
                ),
                contentType,
                status: response.status,
              };
            }

            const bytes = yield* collectBytes(response.stream, 64 * 1024).pipe(
              Effect.mapError(() =>
                refusal(
                  "The peon upstream returned an unreadable error or exceeded the 64 KiB error cap. Check the upstream and retry.",
                  503
                )
              )
            );

            const error = Schema.decodeUnknownOption(
              Schema.fromJsonString(ProviderError)
            )(new TextDecoder().decode(bytes));

            const retry =
              [429, 503, 529].includes(response.status) ||
              (Option.isSome(error) &&
                error.value.error.type === "overloaded_error");

            if (!retry || delay === 8000) {
              return {
                body: Stream.make(bytes),
                contentType,
                status: response.status,
              };
            }
          }

          return yield* Effect.die(
            "Peon proxy exhausted its retry schedule without a response"
          );
        });

        return Proxy.of({ forward });
      })
    );
}

const proxyResponses = implement(
  defineContract("proxyResponses", {
    annotations: { idempotent: false, readOnly: true },
    description:
      "Forward Codex Responses and Pi function tools to one host provider without exposing its key",
    failure: BridgeFailure,
    input: ProxyInput,
    output: ProxyOutput,
  }),
  (input) => Proxy.use(({ forward }) => forward(input))
);

export const proxyRoute = Effect.gen(function* proxyResponse() {
  const incoming = yield* HttpServerRequest.HttpServerRequest;

  if (incoming.method !== "POST" || incoming.url !== "/v1/responses") {
    return yield* refusal(
      "Only POST /v1/responses without a query is supported. Use that exact Responses target."
    );
  }

  const text = yield* readBody;

  const body = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(MessageBody)
  )(text).pipe(
    Effect.mapError(() =>
      refusal(
        "Invalid Responses JSON object. Send model gpt-6.1-sol, input and Pi function tools to POST /v1/responses."
      )
    )
  );

  const output = yield* proxyResponses.handler({
    body,
    headers: incoming.headers,
  });

  return HttpServerResponse.stream(output.body, {
    contentType: output.contentType,
    status: output.status,
  });
}).pipe(
  Effect.catchTag("BridgeFailure", (failure) =>
    Effect.succeed(errorResponse(failure))
  )
);

const refused = HttpServerResponse.jsonUnsafe(
  {
    error: {
      message:
        "Only POST /v1/responses is supported. Use the peon OpenAI Responses provider at that exact method and path.",
    },
  },
  { status: 405 }
);

export const proxyRoutes = Layer.mergeAll(
  HttpRouter.add("POST", "/v1/responses", proxyRoute),
  HttpRouter.add("*", "/*", Effect.succeed(refused))
);
