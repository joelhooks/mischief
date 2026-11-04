import type {
  AnyContract,
  HttpRoute,
  InputSchema,
  PlainSchema,
} from "@mischief/capability/contract";
import {
  completeScheduleContract,
  createScheduleContract,
  inspectScheduleContract,
  runCapabilities,
} from "@mischief/core";
import { importSigning } from "@rat-king/mailbox-client";
import type { IdentityValue } from "@rat-king/mailbox-client";
import { serviceToken } from "@rat-king/mailbox-client/auth";
import { Clock, Context, Crypto, Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { ClientError } from "./client-error.js";

export const Host = Schema.Struct({
  audience: Schema.String.check(
    Schema.isPattern(/^did:web:[^\s#]+#mischief$/u)
  ),
  endpoint: Schema.String.check(
    Schema.makeFilter((value) => {
      try {
        const url = new URL(value);

        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/"
        );
      } catch {
        return false;
      }
    })
  ),
});

type Call<C extends AnyContract> = (
  input: C["input"]["Type"]
) => Effect.Effect<C["output"]["Type"], C["failure"]["Type"] | ClientError>;

export interface MischiefClient {
  readonly abortRun: Call<(typeof runCapabilities)[5]["contract"]>;
  readonly completeSchedule: Call<typeof completeScheduleContract>;
  readonly createSchedule: Call<typeof createScheduleContract>;
  readonly deliverReply: Call<(typeof runCapabilities)[7]["contract"]>;
  readonly inspectRun: Call<(typeof runCapabilities)[1]["contract"]>;
  readonly inspectSchedule: Call<typeof inspectScheduleContract>;
  readonly readRun: Call<(typeof runCapabilities)[2]["contract"]>;
  readonly submitPlan: Call<(typeof runCapabilities)[0]["contract"]>;
}

const Refusal = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
  reason: Schema.optionalKey(Schema.String),
});

export const makeClient = Effect.fn("MischiefClient.make")(function* makeClient(
  host: typeof Host.Type,
  identity: IdentityValue
): Effect.fn.Return<
  MischiefClient,
  ClientError,
  HttpClient.HttpClient | Crypto.Crypto
> {
  const config = yield* Schema.decodeUnknownEffect(Host)(host).pipe(
    Effect.mapError(
      () =>
        new ClientError({
          kind: "configuration",
          operation: "configure",
          reason:
            "Invalid Mischief host. Configure an HTTP(S) origin without credentials, path, query or fragment, and the host DID followed by #mischief as audience; retry makeClient.",
        })
    )
  );

  const key = yield* importSigning(identity).pipe(
    Effect.mapError(
      () =>
        new ClientError({
          kind: "identity",
          operation: "configure",
          reason:
            "The existing Rat King identity has no usable ES256 signing key. Check the caller's identity in agent-secrets, then retry makeClient.",
        })
    )
  );

  const http = yield* HttpClient.HttpClient;
  const cryptography = yield* Crypto.Crypto;

  const method = <
    I extends InputSchema,
    O extends PlainSchema,
    F extends PlainSchema & { readonly Type: { readonly _tag: string } },
  >(contract: {
    readonly name: string;
    readonly input: I;
    readonly output: O;
    readonly failure: F;
    readonly http: HttpRoute | undefined;
  }) =>
    Effect.fn(`MischiefClient.${contract.name}`)(function* call(
      input: I["Type"]
    ): Effect.fn.Return<O["Type"], F["Type"] | ClientError> {
      const body = yield* Schema.encodeEffect(contract.input)(input).pipe(
        Effect.mapError(
          () =>
            new ClientError({
              kind: "input",
              operation: contract.name,
              reason: `Invalid ${contract.name} input. Use the capability's input schema, then retry ${contract.name}.`,
            })
        )
      );

      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

      const token = yield* serviceToken(
        {
          aud: config.audience,
          exp: now + 60,
          iat: now,
          iss: identity.did,
          jti: yield* cryptography.randomUUIDv4(),
          lxm: `sh.mschf.mischief.${contract.name}`,
        },
        key
      ).pipe(
        Effect.mapError(
          () =>
            new ClientError({
              kind: "identity",
              operation: contract.name,
              reason:
                "Could not sign the Mischief service token. Check the caller's Rat King identity, then retry the request.",
            })
        )
      );

      const request = yield* HttpClientRequest.post(
        new URL(contract.http?.path ?? `/${contract.name}`, config.endpoint)
          .href
      ).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
        HttpClientRequest.bodyJson(body),
        Effect.mapError(
          () =>
            new ClientError({
              kind: "input",
              operation: contract.name,
              reason: `Cannot encode ${contract.name} as JSON. Use the capability's input schema, then retry ${contract.name}.`,
            })
        )
      );

      const response = yield* http.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "error",
        }),
        Effect.mapError(
          () =>
            new ClientError({
              kind: "transport",
              operation: contract.name,
              reason: `Mischief ${contract.name} did not reach the configured host. Check its origin and connection, then inspectRun before retrying a write.`,
            })
        )
      );

      const json = yield* response.json.pipe(
        Effect.mapError(
          () =>
            new ClientError({
              kind: "protocol",
              operation: contract.name,
              reason: `Mischief ${contract.name} returned non-JSON. Check the host version and retry inspectRun.`,
              status: response.status,
            })
        )
      );

      if (response.status < 200 || response.status >= 300) {
        const declared = Schema.decodeUnknownOption(contract.failure)(json);

        if (Option.isSome(declared)) {
          return yield* Effect.fail(declared.value);
        }

        const refusal = Schema.decodeUnknownOption(Refusal)(json);

        const reason = Option.isSome(refusal)
          ? (refusal.value.reason ??
            refusal.value.error ??
            refusal.value.errors?.join("\n"))
          : undefined;

        return yield* new ClientError({
          kind: "refused",
          operation: contract.name,
          reason:
            reason ??
            `Mischief ${contract.name} refused HTTP ${response.status}. Check the host version, then retry inspectRun.`,
          response: yield* Schema.decodeUnknownEffect(Schema.Json)(json).pipe(
            Effect.mapError(
              () =>
                new ClientError({
                  kind: "protocol",
                  operation: contract.name,
                  reason:
                    "The host returned an invalid JSON refusal. Check the host version, then retry inspectRun.",
                })
            )
          ),
          status: response.status,
        });
      }

      return yield* Schema.decodeUnknownEffect(contract.output)(json).pipe(
        Effect.mapError(
          () =>
            new ClientError({
              kind: "protocol",
              operation: contract.name,
              reason: `Mischief ${contract.name} returned data outside its output schema. Check the host and client versions, then retry inspectRun.`,
              status: response.status,
            })
        )
      );
    });

  return {
    abortRun: method(runCapabilities[5].contract),
    completeSchedule: method(completeScheduleContract),
    createSchedule: method(createScheduleContract),
    deliverReply: method(runCapabilities[7].contract),
    inspectRun: method(runCapabilities[1].contract),
    inspectSchedule: method(inspectScheduleContract),
    readRun: method(runCapabilities[2].contract),
    submitPlan: method(runCapabilities[0].contract),
  };
});

export class Client extends Context.Service<Client, MischiefClient>()(
  "@mischief/client/Client"
) {
  static readonly layer = (host: typeof Host.Type, identity: IdentityValue) =>
    Layer.effect(Client, makeClient(host, identity));
}
