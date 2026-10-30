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
    input_schema: Schema.Record(Schema.String, Schema.Unknown),
    name: Schema.Literals(["read", "grep", "find", "ls", "bash"]),
    type: Schema.optionalKey(Schema.Literal("custom")),
  })
);

const MESSAGE_FIELDS = new Set([
  "betas",
  "cache_control",
  "max_tokens",
  "messages",
  "metadata",
  "model",
  "output_config",
  "service_tier",
  "stop_sequences",
  "stream",
  "system",
  "temperature",
  "thinking",
  "tool_choice",
  "tools",
  "top_k",
  "top_p",
]);

const ProxyInput = Schema.Struct({
  beta: Schema.String,
  body: MessageBody,
  version: Schema.String,
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
          Schema.Array(Schema.Literal("claude-opus-5-5")).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(1)
          )
        )(config.models).pipe(
          Effect.mapError(() =>
            refusal(
              'MISCHIEF_PEON_MODELS must be ["claude-opus-5-5"]. Peons are Opus-only; correct the allowlist and restart the proxy.'
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
            "MISCHIEF_PEON_CLIPROXY_URL is not a credential-free HTTP base URL. Configure the dedicated peon Messages provider before starting."
          );
        }

        const upstream = `${config.upstream.replace(/\/$/u, "")}/v1/messages`;

        const forward = Effect.fn("PeonProxy.forward")(function* forward(
          request: typeof ProxyInput.Type
        ) {
          if (
            !Schema.is(Schema.Literal("claude-opus-5-5"))(request.body.model) ||
            !models.includes(request.body.model)
          ) {
            return yield* refusal(
              `This proxy permits only ${models.join(", ")}. Select peon/claude-opus-5-5 and retry.`,
              403
            );
          }

          if (
            Object.keys(request.body).some((key) => !MESSAGE_FIELDS.has(key))
          ) {
            return yield* refusal(
              "Unsupported Messages field. Provider-side connectors and containers are not permitted; send only ordinary Pi Messages fields and client tools."
            );
          }

          if (request.body.max_tokens !== undefined) {
            yield* Schema.decodeUnknownEffect(
              Schema.Int.check(
                Schema.isBetween({ maximum: 128_000, minimum: 1 })
              )
            )(request.body.max_tokens).pipe(
              Effect.mapError(() =>
                refusal(
                  "The peon proxy permits max_tokens from 1 through 128000. Reduce that per-response ceiling and retry."
                )
              )
            );
          }

          if (request.body.tools !== undefined) {
            yield* Schema.decodeUnknownEffect(ClientTools)(
              request.body.tools
            ).pipe(
              Effect.mapError(() =>
                refusal(
                  "Only client tools read, grep, find, ls, bash with input_schema are permitted. Remove provider-side tools and connectors before retrying.",
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
                  HttpClientRequest.setHeaders({
                    "anthropic-beta": request.beta,
                    "anthropic-version": request.version,
                    authorization: `Bearer ${Redacted.value(config.key)}`,
                    "x-api-key": Redacted.value(config.key),
                    "x-cliproxy-client": "mischief/peons",
                  }),
                  HttpClientRequest.bodyJsonUnsafe(request.body)
                )
              )
              .pipe(
                Effect.mapError(() =>
                  refusal(
                    "The peon Messages upstream is unavailable. Check the host proxy provider and resume the think.",
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
                      "The peon Messages stream was interrupted. Check the upstream and resume the think.",
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

const proxyMessages = implement(
  defineContract("proxyMessages", {
    annotations: { idempotent: false, readOnly: true },
    description:
      "Forward Opus Messages and tool calls to one host provider without exposing its key",
    failure: BridgeFailure,
    input: ProxyInput,
    output: ProxyOutput,
  }),
  (input) => Proxy.use(({ forward }) => forward(input))
);

export const proxyRoute = Effect.gen(function* proxyResponse() {
  const incoming = yield* HttpServerRequest.HttpServerRequest;

  if (incoming.url !== "/v1/messages") {
    return yield* refusal(
      "Only POST /v1/messages without a query string is supported. Use that exact Messages endpoint."
    );
  }

  const text = yield* readBody;

  const body = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(MessageBody)
  )(text).pipe(
    Effect.mapError(() =>
      refusal(
        "Invalid Messages JSON object. Send model claude-opus-5-5, messages and tool definitions to POST /v1/messages."
      )
    )
  );

  const output = yield* proxyMessages.handler({
    beta: incoming.headers["anthropic-beta"] ?? "",
    body,
    version: incoming.headers["anthropic-version"] ?? "2023-06-01",
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
        "Only POST /v1/messages is supported. Use the peon Anthropic Messages provider at that exact method and path.",
    },
  },
  { status: 405 }
);

export const proxyRoutes = Layer.mergeAll(
  HttpRouter.add("POST", "/v1/messages", proxyRoute),
  HttpRouter.add("*", "/*", Effect.succeed(refused))
);
