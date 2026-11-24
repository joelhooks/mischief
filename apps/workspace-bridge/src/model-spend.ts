import { isIPv4 } from "node:net";

import { BridgeFailure } from "@mischief/model-bridge/bridge-failure";
import { Config, Effect, Option, Redacted, Schema, Stream } from "effect";
import { HttpClientRequest, HttpServerResponse } from "effect/http";
import type { HttpClient } from "effect/http";

import { ipv4Peer } from "./box/live-owner.js";
import {
  ADMIT_PATH,
  RECORD_PATH,
  SpendPermit,
  spendMessage,
} from "./box/spend-protocol.js";
import { errorResponse } from "./http.js";
import { estimatedTokens, usageFrames } from "./model-usage.js";
import { refusal } from "./protocol.js";

export interface ModelMeter {
  readonly record: (tokens: number) => Effect.Effect<void, BridgeFailure>;
}

export type ModelSpend = (
  peer: string,
  requestBytes: number
) => Effect.Effect<ModelMeter | undefined, BridgeFailure>;

export const managerKey = Effect.gen(function* modelSpendManagerKey() {
  const key = yield* Config.Redacted("MISCHIEF_BOX_KEY");

  if (Redacted.value(key).trim() === "") {
    return yield* refusal(
      "Set the nonempty MISCHIEF_BOX_KEY shared by the box manager and model proxies."
    );
  }

  return key;
});

export const admitModel = (
  spend: ModelSpend | undefined,
  peer: string | undefined,
  bytes: number
) => spend?.(peer ?? "", bytes) ?? Effect.undefined;

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
  const post = (path: string, body: Schema.Json, key: Redacted.Redacted) =>
    client
      .execute(
        HttpClientRequest.post(`http://127.0.0.1:28014${path}`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(key)),
          HttpClientRequest.bodyJsonUnsafe(body)
        )
      )
      .pipe(
        Effect.mapError(managerUnavailable),
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(managerUnavailable()),
        })
      );

  return Effect.fn("ModelSpend.admit")(function* admit(
    peer: string,
    requestBytes: number
  ) {
    if (restricted && workspacePeer(peer)) {
      return yield* Effect.undefined;
    }

    if (manager === undefined || !isIPv4(ipv4Peer(peer))) {
      return yield* unidentified();
    }

    const response = yield* post(
      ADMIT_PATH,
      { peer, tokens: estimatedTokens(requestBytes) },
      manager
    );

    if (response.status !== 200) {
      return yield* response.text.pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.fail(
            response.status === 403 ? unidentified() : managerUnavailable()
          )
        )
      );
    }

    const permit = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SpendPermit)),
      Effect.mapError(managerUnavailable)
    );

    if (permit.status === "denied") {
      return yield* refusal(spendMessage(permit.reason), 429);
    }

    if (permit.status === "uncapped") {
      return yield* Effect.undefined;
    }

    return {
      record: (tokens: number) =>
        post(RECORD_PATH, { receipt: permit.receipt, tokens }, manager).pipe(
          Effect.flatMap((result) =>
            result.status === 204
              ? Effect.void
              : result.text.pipe(
                  Effect.ignore,
                  Effect.andThen(Effect.fail(managerUnavailable()))
                )
          )
        ),
    };
  });
};

export const meterResponse = <E>(
  meter: ModelMeter | undefined,
  requestBytes: number,
  contentType: string,
  stream: Stream.Stream<Uint8Array, E>
) =>
  meter === undefined
    ? stream
    : Stream.suspend(() => {
        const usage = usageFrames(contentType);
        let bytes = 0;
        let charged = estimatedTokens(requestBytes);

        const record = Effect.fnUntraced(function* record() {
          const tokens = usage.tokens(requestBytes, bytes);

          if (tokens > charged) {
            yield* meter.record(tokens);
            charged = tokens;
          }
        });

        return stream.pipe(
          Stream.tap((chunk) =>
            Effect.suspend(() => {
              usage.push(chunk);
              bytes += chunk.byteLength;

              return record();
            })
          ),
          Stream.onEnd(
            Effect.suspend(() => {
              usage.end();

              return record();
            })
          )
        );
      });

export const proxyFailureResponse = (failure: BridgeFailure) =>
  failure.status === 429 && failure.message.startsWith("SpendCap:")
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
