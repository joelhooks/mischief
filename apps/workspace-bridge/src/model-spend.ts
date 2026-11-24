import { isIPv4 } from "node:net";

import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Effect, Option, Redacted, Schedule, Schema, Stream } from "effect";
import { uuidV4Unsafe } from "effect/crypto/SecureRandom";
import {
  HttpClientError,
  HttpClientRequest,
  HttpServerResponse,
} from "effect/http";
import type { HttpClient } from "effect/http";

import { ipv4Peer } from "./box/live-owner.js";
import {
  ADMIT_PATH,
  RECORD_PATH,
  SpendPermit,
  SpendProgress,
  spendMessage,
  spendReading,
} from "./box/spend-protocol.js";
import { errorResponse } from "./http.js";
import { estimatedTokens, isEventStream, usageFrames } from "./model-usage.js";
import { refusal } from "./protocol.js";
import { collectBytes } from "./runner.js";

export interface ModelMeter {
  readonly record: (
    tokens: number,
    settled: boolean
  ) => Effect.Effect<void, BridgeFailure>;
}

export type ModelSpend = (
  peer: string,
  requestBytes: number,
  outputTokens?: number
) => Effect.Effect<
  (ModelMeter & { readonly outputTokens: number }) | undefined,
  BridgeFailure
>;

export { spendKeyFromConfig as managerKey } from "./box/spend-key.js";

const OutputLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 1_000_000_000 })
);

export const ModelBodySchema = Schema.Record(Schema.String, Schema.Unknown);

type ModelBody = typeof ModelBodySchema.Type;

type OutputKey = "max_tokens" | "max_output_tokens";

export const admitModel = Effect.fnUntraced(function* admitRequest(
  spend: ModelSpend | undefined,
  peer: string | undefined,
  bytes: number,
  body: ModelBody,
  outputKey: OutputKey
) {
  if (spend === undefined) {
    return yield* Effect.undefined;
  }

  const requested = body[outputKey];

  if (requested !== undefined && !Schema.is(OutputLimit)(requested)) {
    return yield* refusal(
      "Model output ceiling must be a positive integer. Correct max_tokens or max_output_tokens and retry."
    );
  }

  return yield* spend(peer ?? "", bytes, requested);
});

export const outputKeyFor = (messages: boolean) =>
  messages ? "max_tokens" : "max_output_tokens";

export const modelWire = (
  wire: string,
  body: ModelBody,
  outputKey: OutputKey,
  meter: { readonly outputTokens: number } | undefined
) =>
  meter !== undefined && body[outputKey] === undefined
    ? JSON.stringify({ ...body, [outputKey]: meter.outputTokens })
    : wire;

export const measuredRequest = (
  request: HttpClientRequest.HttpClientRequest,
  meter: ModelMeter | undefined
) =>
  meter === undefined
    ? request
    : HttpClientRequest.setHeader(request, "accept-encoding", "identity");

export const preserveSpendFailure =
  (fallback: BridgeFailure) => (cause: unknown) =>
    Schema.is(BridgeFailure)(cause) ? cause : fallback;

export const measuredEncoding = (
  meter: ModelMeter | undefined,
  encoding: string | undefined
) =>
  meter === undefined ||
  encoding === undefined ||
  encoding.toLowerCase() === "identity"
    ? Effect.void
    : Effect.fail(
        refusal(
          "The provider ignored identity encoding, so usage frames could not be measured. Inspect the provider and retry promptPeon.",
          502
        )
      );

const managerUnavailable = () =>
  refusal(
    "The box manager could not confirm model spend. Check its health and the shared host bearer, then retry promptPeon.",
    503
  );

const unidentified = () =>
  refusal(
    "Model requests need an approved workspace or managed box network peer. Use the assigned model proxy from a running peon.",
    403
  );

const TRANSIENT_MANAGER_FAILURE = "manager-transport";

const transientManagerFailure = (): typeof TRANSIENT_MANAGER_FAILURE =>
  TRANSIENT_MANAGER_FAILURE;

type ManagerFailure = BridgeFailure | typeof TRANSIENT_MANAGER_FAILURE;

const managerTransportFailure = (
  error: HttpClientError.HttpClientError
): ManagerFailure =>
  error.reason instanceof HttpClientError.TransportError
    ? TRANSIENT_MANAGER_FAILURE
    : managerUnavailable();

const managerHttpFailure = (status: number): ManagerFailure => {
  if (status === 503) {
    return TRANSIENT_MANAGER_FAILURE;
  }

  return status === 403 ? unidentified() : managerUnavailable();
};

const isTransientManagerFailure = (
  error: ManagerFailure
): error is typeof TRANSIENT_MANAGER_FAILURE =>
  error === TRANSIENT_MANAGER_FAILURE;

const workspacePeer = (peer: string) => {
  const address = ipv4Peer(peer);

  return (
    isIPv4(address) &&
    address.startsWith("172.30.211.") &&
    address !== "172.30.211.1"
  );
};

export const modelSpend = (
  client: HttpClient.HttpClient,
  manager: Redacted.Redacted | undefined,
  restricted: boolean
): ModelSpend => {
  const post = <A>(
    path: string,
    body: Schema.Json,
    key: Redacted.Redacted,
    schema: Schema.Decoder<A>
  ) =>
    client
      .execute(
        HttpClientRequest.post(`http://127.0.0.1:28014${path}`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(key)),
          HttpClientRequest.bodyJsonUnsafe(body)
        )
      )
      .pipe(
        Effect.mapError(managerTransportFailure),
        Effect.flatMap((response) =>
          response.status === 200
            ? response.text.pipe(
                Effect.mapError(transientManagerFailure),
                Effect.flatMap((reply) =>
                  Schema.decodeEffect(Schema.fromJsonString(schema))(
                    reply
                  ).pipe(Effect.mapError(managerUnavailable))
                )
              )
            : response.text.pipe(
                Effect.ignore,
                Effect.andThen(Effect.fail(managerHttpFailure(response.status)))
              )
        ),
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(managerUnavailable()),
        })
      );

  return Effect.fn("ModelSpend.admit")(function* admit(
    peer: string,
    requestBytes: number,
    outputTokens?: number
  ) {
    if (restricted && workspacePeer(peer)) {
      return yield* Effect.undefined;
    }

    if (manager === undefined || !isIPv4(ipv4Peer(peer))) {
      return yield* unidentified();
    }

    const input = {
      peer,
      requestId: uuidV4Unsafe(),
      tokens: estimatedTokens(requestBytes),
    };

    const permit = yield* post(
      ADMIT_PATH,
      outputTokens === undefined ? input : { ...input, outputTokens },
      manager,
      SpendPermit
    ).pipe(
      Effect.retry({
        schedule: Schedule.spaced("250 millis"),
        while: isTransientManagerFailure,
      }),
      Effect.catchIf(isTransientManagerFailure, () =>
        Effect.fail(managerUnavailable())
      ),
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(managerUnavailable()),
      })
    );

    if (permit.status === "denied") {
      return yield* refusal(spendMessage(permit.reason), 429);
    }

    if (permit.status === "uncapped") {
      return yield* Effect.undefined;
    }

    return {
      outputTokens: permit.outputTokens,
      record: (tokens: number, settled: boolean) =>
        post(
          RECORD_PATH,
          spendReading(permit.receipt, tokens, settled),
          manager,
          SpendProgress
        ).pipe(
          Effect.catchIf(isTransientManagerFailure, () =>
            Effect.fail(managerUnavailable())
          ),
          Effect.flatMap(({ allowed }) =>
            allowed
              ? Effect.void
              : Effect.fail(refusal(spendMessage("daily"), 429))
          )
        ),
    };
  });
};

const isSpendCap = <E>(failure: E): failure is E & BridgeFailure =>
  Schema.is(BridgeFailure)(failure) &&
  failure.status === 429 &&
  failure.message.startsWith("SpendCap:");

export const preserveSpendCap =
  (fallback: BridgeFailure) =>
  (cause: BridgeFailure | HttpClientError.HttpClientError) =>
    isSpendCap(cause) ? cause : fallback;

const cappedFrame = (failure: BridgeFailure, messages: boolean) => {
  const error = {
    code: "SpendCap",
    type: "rate_limit_error",
    message: failure.message,
  };

  const frame = messages
    ? { type: "error", error }
    : { ...error, type: "error", param: null };

  return new TextEncoder().encode(
    `event: error\ndata: ${JSON.stringify(frame)}\n\n`
  );
};

const frameEnd = (bytes: Uint8Array) => {
  const wire = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).toString("latin1");

  let end = 0;

  for (const match of wire.matchAll(/\r?\n\r?\n/gu)) {
    end = match.index + match[0].length;
  }

  return end;
};

export const meterResponse = <E>(
  meter: ModelMeter | undefined,
  requestBytes: number,
  contentType: string,
  stream: Stream.Stream<Uint8Array, E>,
  messages = false
) =>
  meter === undefined
    ? stream
    : Stream.suspend(() => {
        const usage = usageFrames(contentType);
        const sse = isEventStream(contentType);
        let bytes = 0;
        let charged = estimatedTokens(requestBytes);
        let pending = Buffer.alloc(0);
        let settled = false;

        const settle = Effect.gen(function* settleUsage() {
          if (!settled) {
            yield* meter.record(usage.tokens(requestBytes, bytes, true), true);
            settled = true;
          }
        });

        const observe = Effect.fnUntraced(function* observe(chunk: Uint8Array) {
          usage.push(chunk);
          bytes += chunk.byteLength;

          if (usage.complete()) {
            yield* settle;
          } else {
            const tokens = usage.tokens(requestBytes, bytes, false);

            if (tokens > charged) {
              yield* meter.record(tokens, false);
              charged = tokens;
            }
          }

          if (!sse) {
            return chunk;
          }

          const joined = Buffer.concat([pending, chunk]);
          const end = frameEnd(joined);
          pending = joined.subarray(end);

          if (pending.byteLength > 4 * 1024 * 1024) {
            return yield* refusal(
              "Provider event exceeded 4 MiB without a frame boundary. Inspect the provider and retry promptPeon.",
              502
            );
          }

          return joined.subarray(0, end);
        });

        const finish = Effect.gen(function* settleModelSpend() {
          usage.end();

          if (!sse || usage.complete()) {
            yield* settle;
          }

          return pending;
        });

        const frameOrFail = (cause: E | BridgeFailure) =>
          sse && isSpendCap(cause)
            ? Stream.make(cappedFrame(cause, messages))
            : Stream.fail(cause);

        return stream.pipe(
          Stream.mapEffect(observe),
          Stream.concat(Stream.fromEffect(finish)),
          Stream.catch(frameOrFail)
        );
      });

export const prepareMeteredResponse = <E>(
  meter: ModelMeter | undefined,
  contentType: string,
  stream: Stream.Stream<Uint8Array, E>
) =>
  meter === undefined || isEventStream(contentType)
    ? Effect.succeed(stream)
    : collectBytes(stream, 8 * 1024 * 1024).pipe(
        Effect.map((bytes) => Stream.make(bytes))
      );

export const proxyFailureResponse = (failure: BridgeFailure) =>
  isSpendCap(failure)
    ? HttpServerResponse.jsonUnsafe(
        {
          type: "error",
          error: {
            code: "SpendCap",
            type: "rate_limit_error",
            message: failure.message,
          },
        },
        { status: 429 }
      )
    : errorResponse(failure);

export const socketPeer = (peer: Option.Option<string>) =>
  Option.getOrElse(peer, () => "");

const CLAIMED_IDENTITY = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-real-ip",
  "x-peon-id",
  "x-mischief-peon-id",
]);

export const modelHeaders = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !CLAIMED_IDENTITY.has(name.toLowerCase())
    )
  );
