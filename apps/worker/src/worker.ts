// @effect-diagnostics asyncFunction:off -- the Worker's fetch handler is a Promise API.
import { Option, Schema } from "effect";

import type { Env } from "./plan-run-object.js";

export { PlanRun } from "./plan-run-object.js";

const decodeRunId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ runId: Schema.String }))
);

const NO_RUN_ID =
  "this request names no run. Every run capability takes a JSON body with runId; deliverReply goes through the mail role, which finds the run from replyTo. Add runId to the body and send it again";

export default {
  async fetch(request: Request, env: Env) {
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
