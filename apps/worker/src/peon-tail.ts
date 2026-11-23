import { BoxTailResult, PeonRefused } from "@mischief/core";
import type {
  PeonReport,
  PeonTailContext,
  tailPeonContract,
} from "@mischief/core";
import { Effect } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import type { Env } from "./plan-run-object.js";

export const safeLastTurn = (
  turn: typeof PeonReport.Type.lastTurn
): typeof PeonTailContext.Type.lastTurn => {
  if (turn === null) {
    return null;
  }

  const safe = {
    exit: turn.exit,
    toolCallCount: turn.toolCalls.length,
    usage: turn.usage,
    wallMs: turn.wallMs,
  };

  return turn.resumeMs === undefined
    ? safe
    : { ...safe, resumeMs: turn.resumeMs };
};

export const fetchPeonTail = (
  env: Env,
  { peonId, ...query }: typeof tailPeonContract.input.Type
) =>
  Effect.gen(function* fetchTail() {
    const request = HttpClientRequest.post(
      new URL(`/v1/boxes/${peonId}/tail`, env.MISCHIEF_BOX_URL).href
    ).pipe(
      HttpClientRequest.setHeader(
        "authorization",
        `Bearer ${env.MISCHIEF_BOX_KEY ?? ""}`
      ),
      HttpClientRequest.bodyText(JSON.stringify(query), "application/json")
    );

    const response = yield* HttpClient.execute(request);

    if (response.status === 404) {
      return { reason: "absent", status: "not-live" } as const;
    }

    const ok = yield* HttpClientResponse.filterStatusOk(response);

    return yield* HttpClientResponse.schemaBodyJson(BoxTailResult)(ok);
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError(
      () =>
        new PeonRefused({
          reason:
            "Box manager could not return a safe session tail. Check that the box manager supports tail and retry tailPeon.",
        })
    )
  );
