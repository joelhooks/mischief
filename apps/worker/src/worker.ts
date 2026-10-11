// @effect-diagnostics asyncFunction:off -- the Worker's fetch handler is a Promise API.
import { runApiSpec } from "@mischief/plan-run";
import { Option, Schema } from "effect";

import type { Env } from "./plan-run-object.js";

export { PlanRun } from "./plan-run-object.js";

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

const NO_TOKEN =
  "this Mischief host has no MISCHIEF_CREDENTIAL secret, so it serves nobody. Set the secret on the Worker, then call again with Authorization: Bearer <token>";

const BAD_TOKEN =
  "this request carries no valid bearer token. Send Authorization: Bearer <token> with the host's MISCHIEF_CREDENTIAL";

const encoder = new TextEncoder();

const digestOf = async (text: string) =>
  await crypto.subtle.digest("SHA-256", encoder.encode(text));

const authorized = async (request: Request, token: string) => {
  const presented = request.headers.get("authorization") ?? "";

  return crypto.subtle.timingSafeEqual(
    await digestOf(presented),
    await digestOf(`Bearer ${token}`)
  );
};

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

    if (
      env.MISCHIEF_CREDENTIAL === undefined ||
      env.MISCHIEF_CREDENTIAL === ""
    ) {
      return Response.json({ error: NO_TOKEN }, { status: 503 });
    }

    if (!(await authorized(request, env.MISCHIEF_CREDENTIAL))) {
      return Response.json({ error: BAD_TOKEN }, { status: 401 });
    }

    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/openapi.json"
    ) {
      return Response.json(runApiSpec());
    }

    const body = await request.text();
    const runId = runIdOf(body);

    if (Option.isNone(runId)) {
      return Response.json({ error: NO_RUN_ID }, { status: 400 });
    }

    const run = env.PLAN_RUN.get(
      env.PLAN_RUN.idFromName(`${env.MISCHIEF_DESK}/${runId.value}`)
    );

    return await run.fetch(
      new Request(request.url, {
        body,
        headers: request.headers,
        method: request.method,
      })
    );
  },
} satisfies ExportedHandler<Env>;
