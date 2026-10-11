// @effect-diagnostics asyncFunction:off -- the Worker's fetch handler is a Promise API.
import { runApiSpec } from "@mischief/plan-run";
import { Documents, staticResolver } from "@rat-king/mailbox-client";
import type { DocumentsValue } from "@rat-king/mailbox-client";
import { Effect, Layer, Option, Result, Schema } from "effect";

import type { Env } from "./plan-run-object.js";
import {
  AuthRefused,
  authenticate,
  NSID_PREFIX,
  ServiceTokens,
} from "./service-auth.js";

export { PlanRun } from "./plan-run-object.js";

export { ServiceTokenLedger } from "./service-tokens.js";

const decodeAddress = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      replyTo: Schema.optionalKey(Schema.String),
      runId: Schema.optionalKey(Schema.String),
    })
  )
);

const runIdOf = (body: string) =>
  decodeAddress(body).pipe(
    Option.flatMap(({ replyTo, runId }) =>
      Option.orElse(Option.fromUndefinedOr(runId), () =>
        Option.fromUndefinedOr(replyTo?.split("/")[0])
      )
    ),
    Option.filter((runId) => runId !== "")
  );

const NO_RUN_ID =
  "this request names no run. Every run capability takes a JSON body with runId, and deliverReply finds its run from replyTo (<runId>/<step>#<visit>). Add runId to the body and send it again; GET /openapi.json lists every capability";

const NOT_CONFIGURED =
  "this Mischief host has no MISCHIEF_DID or no valid MISCHIEF_CALLERS (a JSON array of the allowed callers' DID documents), so it serves nobody. Ask the Mischief desk (pi-durable/desk) to deploy it with both";

const CallersFromJson = Schema.fromJsonString(Documents);

const servicesFor = (env: Env, callers: DocumentsValue) =>
  Layer.merge(
    staticResolver(callers),
    Layer.succeed(
      ServiceTokens,
      ServiceTokens.of({
        consume: (claims, now) =>
          Effect.tryPromise({
            catch: () =>
              new AuthRefused({
                reason:
                  "the host could not record this token's jti, so it refuses it. Send a fresh token again shortly",
              }),
            try: async () =>
              await env.SERVICE_TOKENS.getByName(claims.iss).consume(
                claims.jti,
                claims.exp,
                now
              ),
          }),
      })
    )
  );

const refused = (error: AuthRefused) =>
  Response.json({ error: error.reason }, { status: 401 });

declare const __BUNDLE_COMMIT__: string;

declare const __BUNDLE_VERSION__: string;

const VERSION_PATH = "/.well-known/rat-king/version";

export default {
  async fetch(request: Request, env: Env) {
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === VERSION_PATH
    ) {
      return Response.json({
        commit: __BUNDLE_COMMIT__,
        version: __BUNDLE_VERSION__,
      });
    }

    const callers = Schema.decodeUnknownOption(CallersFromJson)(
      env.MISCHIEF_CALLERS ?? ""
    );

    if (
      env.MISCHIEF_DID === undefined ||
      env.MISCHIEF_DID === "" ||
      Option.isNone(callers)
    ) {
      return Response.json({ error: NOT_CONFIGURED }, { status: 503 });
    }

    const { pathname } = new URL(request.url);

    const capability =
      pathname === "/openapi.json" ? "openApi" : pathname.slice(1);

    const caller = await Effect.runPromise(
      authenticate({
        audience: `${env.MISCHIEF_DID}#mischief`,
        authorization: request.headers.get("authorization"),
        lxm: `${NSID_PREFIX}${capability}`,
      }).pipe(Effect.result, Effect.provide(servicesFor(env, callers.value)))
    );

    if (Result.isFailure(caller)) {
      return refused(caller.failure);
    }

    if (request.method === "GET" && pathname === "/openapi.json") {
      return Response.json(runApiSpec());
    }

    const body = await request.text();
    const runId = runIdOf(body);

    if (Option.isNone(runId)) {
      return Response.json({ error: NO_RUN_ID }, { status: 400 });
    }

    const run = env.PLAN_RUN.get(
      env.PLAN_RUN.idFromName(`${caller.success.iss}/${runId.value}`)
    );

    return await run.fetch(
      new Request(request.url, {
        body,
        headers: { "content-type": "application/json" },
        method: request.method,
      })
    );
  },
} satisfies ExportedHandler<Env>;
