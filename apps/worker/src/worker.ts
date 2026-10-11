// @effect-diagnostics asyncFunction:off -- the Worker's fetch handler is a Promise API.
import { Option, Schema } from "effect";

import type { Env } from "./plan-run-object.js";

export { PlanRun } from "./plan-run-object.js";

const decodeRunId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ runId: Schema.String }))
);

const NO_RUN_ID =
  "this request names no run. Every run capability takes a JSON body with runId; deliverReply goes through the mail role, which finds the run from replyTo. Add runId to the body and send it again";

const NO_TOKEN =
  "this Mischief host has no MISCHIEF_TOKEN secret, so it serves nobody. Set the secret on the Worker, then call again with Authorization: Bearer <token>";

const BAD_TOKEN =
  "this request carries no valid bearer token. Send Authorization: Bearer <token> with the host's MISCHIEF_TOKEN";

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

export default {
  async fetch(request: Request, env: Env) {
    if (env.MISCHIEF_TOKEN === undefined || env.MISCHIEF_TOKEN === "") {
      return Response.json({ error: NO_TOKEN }, { status: 503 });
    }

    if (!(await authorized(request, env.MISCHIEF_TOKEN))) {
      return Response.json({ error: BAD_TOKEN }, { status: 401 });
    }

    const body = await request.text();
    const runId = decodeRunId(body);

    if (Option.isNone(runId)) {
      return Response.json({ error: NO_RUN_ID }, { status: 400 });
    }

    const run = env.PLAN_RUN.get(
      env.PLAN_RUN.idFromName(`${env.MISCHIEF_DESK}/${runId.value.runId}`)
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
