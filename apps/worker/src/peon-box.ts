import {
  PeonBoxRefusalCode,
  PeonExportReceipt,
  PeonRefused,
} from "@mischief/core";
import type { PeonTemplate } from "@mischief/core";
import { Effect, Option, Schema } from "effect";
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
  readonly landedHead?: string | undefined;
  readonly discardWorkspace?: true | undefined;
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

type BoxHttpOperation = PeonBoxOperation | "export";

const methodOf = (operation: BoxHttpOperation): "GET" | "DELETE" | "POST" => {
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

const custodyRefusal = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      code: PeonBoxRefusalCode,
      message: Schema.optionalKey(Schema.String),
      dirtyPaths: Schema.optionalKey(Schema.Array(Schema.String)),
      dirtyTotal: Schema.optionalKey(Schema.Int),
      refs: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  })
);

const nextStep = {
  CustodyMissing:
    "Custody is off on this host; destroy is unavailable until custody-on.",
  CustodyIncomplete:
    "Recover the skipped session files, then retry destroyPeon.",
  DestroyInProgress:
    "Retry destroyPeon with the original workspace disposition.",
  ReceiptMismatch:
    "Ask the Mischief operator to check the protected archive before retrying destroyPeon.",
  ReplicaPending:
    "The replica copy hasn't verified yet; retry destroyPeon after it has.",
  ReplicaMismatch:
    "Ask the Mischief operator to repair and verify the replica before retrying destroyPeon.",
  WorkspaceUnlanded:
    "Retry destroyPeon with landedHead (the landed commit) or discardWorkspace: true.",
} satisfies Record<typeof PeonBoxRefusalCode.Type, string>;

const listDetails = (
  label: string,
  items: readonly string[],
  total: number,
  budget: number
) => {
  if (total === 0) {
    return "";
  }

  for (let count = Math.min(items.length, 20); count >= 0; count -= 1) {
    const omitted = total - count;
    const entries = items.slice(0, count);

    const summary = [
      ...entries,
      ...(omitted === 0 ? [] : [`…and ${omitted} more`]),
    ];

    const detail = ` ${label}: ${summary.join(", ")}.`;

    if (detail.length <= budget) {
      return detail;
    }
  }

  return "";
};

const unlandedDetails = (
  {
    dirtyPaths = [],
    dirtyTotal = 0,
    refs = [],
  }: (typeof custodyRefusal.Type)["error"],
  budget: number
) => {
  const paths = listDetails(
    "Unlanded paths",
    dirtyPaths,
    Math.max(dirtyTotal, dirtyPaths.length),
    Math.floor(budget / 2)
  );

  const refDetails = listDetails(
    "Unlanded refs",
    refs,
    refs.length,
    budget - paths.length
  );

  return paths + refDetails;
};

const exportReply = Schema.fromJsonString(
  Schema.Struct({ exportReceipt: PeonExportReceipt })
);

const jsonObject = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Json)
);

const requireSuccess = (
  peonId: string,
  operation: BoxHttpOperation,
  response: { readonly status: number; readonly text: string }
) =>
  Effect.gen(function* checkBoxResponse() {
    if (response.status >= 200 && response.status < 300) {
      return response.text;
    }

    const reply = Schema.decodeOption(custodyRefusal)(response.text);
    const context = `Box ${peonId} ${operation} returned HTTP ${response.status}`;

    if (Option.isSome(reply)) {
      const { error } = reply.value;
      const bridgeMessage = error.message ?? "";

      const message =
        bridgeMessage.length > 512
          ? `${bridgeMessage.slice(0, 511)}…`
          : bridgeMessage;

      const prefix = `${context} (${error.code}).${message === "" ? "" : ` ${message}`}`;
      const suffix = ` ${nextStep[error.code]}`;

      const details =
        error.code === "WorkspaceUnlanded"
          ? unlandedDetails(error, 1023 - prefix.length - suffix.length)
          : "";

      return yield* new PeonRefused({
        code: error.code,
        reason: `${prefix}${details}${suffix}`,
      });
    }

    return yield* new PeonRefused({
      reason: `${context}: ${response.text.slice(0, 1024)}. Call inspectPeon before retrying.`,
    });
  });

const custody = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({ code: Schema.Literal("ReceiptMismatch") }),
  })
);

export const peonBox = (url: string, key: string): PeonBox => {
  const send = Effect.fn("PeonBox.send")(function* send(
    peonId: string,
    operation: BoxHttpOperation,
    body: PeonBoxRequest | undefined
  ) {
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

    return { status: response.status, text };
  });

  return {
    call: (peonId, operation, body, schema) =>
      Effect.gen(function* callBox() {
        if (
          operation === "destroy" &&
          (body === undefined ||
            (body.landedHead === undefined) ===
              (body.discardWorkspace !== true))
        ) {
          return yield* new PeonRefused({
            reason:
              "Box destroy needs exactly one landedHead or discardWorkspace: true.",
          });
        }

        const response = yield* send(peonId, operation, body);

        const needsExport =
          operation === "destroy" &&
          response.status === 409 &&
          Option.isSome(Schema.decodeOption(custody)(response.text));

        let receipt: typeof PeonExportReceipt.Type | undefined;

        if (needsExport) {
          const exported = yield* send(
            peonId,
            "export",
            body === undefined ? undefined : { requestId: body.requestId }
          );

          const exportedText = yield* requireSuccess(
            peonId,
            "export",
            exported
          );

          receipt = (yield* Schema.decodeEffect(exportReply)(exportedText).pipe(
            Effect.mapError(
              () =>
                new PeonRefused({
                  reason:
                    "Box export returned no valid custody receipt. Check the box manager version.",
                })
            )
          )).exportReceipt;
        }

        const final = needsExport
          ? yield* send(peonId, operation, body)
          : response;

        const text = yield* requireSuccess(peonId, operation, final);

        const responseObject =
          receipt === undefined
            ? Option.none()
            : Schema.decodeOption(jsonObject)(text);

        const payload =
          Option.isSome(responseObject) &&
          responseObject.value.exportReceipt === undefined
            ? JSON.stringify({
                ...responseObject.value,
                exportReceipt: receipt,
              })
            : text;

        return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
          payload
        ).pipe(
          Effect.mapError(
            () =>
              new PeonRefused({
                reason: `Box ${peonId} ${operation} returned data outside the box contract. Its requestId remains pending to prevent duplicate work; inspectPeon and check the box manager version.`,
              })
          )
        );
      }).pipe(Effect.provide(FetchHttpClient.layer)),
  };
};
