// @effect-diagnostics asyncFunction:off -- the Worker's fetch handler is a Promise API.
import { mischiefApiSpec } from "@mischief/plan-run";
import { THINK_DEFAULT, THINK_DEFAULT_REVIEW } from "@mischief/thinking";
import { Documents, staticResolver } from "@rat-king/mailbox-client/auth";
import type { DocumentsValue } from "@rat-king/mailbox-client/auth";
import { Clock, Effect, Layer, Option, Result, Schema } from "effect";

import type { Env } from "./plan-run-object.js";
import { OBJECT_HEADER } from "./postbox-mail.js";
import { POSTBOX_NAME } from "./postbox-object.js";
import { READ_ONLY, replayLedger } from "./replay-ledger.js";
import { NO_RUN_ID, runIdOf } from "./run-address.js";
import {
  NO_SCHEDULE_ID,
  SCHEDULE_CAPABILITIES,
  scheduleIdOf,
} from "./schedule-address.js";
import { authenticate, NSID_PREFIX } from "./service-auth.js";
import type { AuthRefused } from "./service-auth.js";
import { RUN_WARN_TOKENS, utcDay } from "./think-tally.js";

const NOT_CONFIGURED =
  "this Mischief host has no MISCHIEF_DID or no valid MISCHIEF_CALLERS (a JSON array of the allowed callers' DID documents), so it serves nobody. Ask the Mischief desk (pi-durable/desk) to deploy it with both";

const CallersFromJson = Schema.fromJsonString(Documents);

const servicesFor = (env: Env, callers: DocumentsValue) =>
  Layer.merge(
    staticResolver(callers),
    replayLedger((issuer) => env.SERVICE_TOKENS.getByName(issuer), READ_ONLY)
  );

const refused = (error: AuthRefused) =>
  Response.json({ error: error.reason }, { status: 401 });

declare const __BUNDLE_COMMIT__: string;

declare const __BUNDLE_VERSION__: string;

const VERSION_PATH = "/.well-known/rat-king/version";

const thinkStatus = async (env: Env) => {
  const day = utcDay(Effect.runSync(Clock.currentTimeMillis));

  const today = await env.POSTBOX.get(
    env.POSTBOX.idFromName(POSTBOX_NAME)
  ).thinkDay(day);

  return {
    default: {
      ...THINK_DEFAULT,
      review: THINK_DEFAULT_REVIEW,
      source: "THINK_DEFAULT in @mischief/thinking; design ledger 2026-10-16",
    },
    host: {
      model: env.MISCHIEF_MODEL,
      wired:
        env.MISCHIEF_MODEL === "faux" ||
        (env.MISCHIEF_MODEL === "cliproxy" &&
          (env.MISCHIEF_CLIPROXY_KEY ?? "") !== "" &&
          (env.MISCHIEF_CLIPROXY_URL ?? "") !== ""),
    },
    today: {
      ...today,
      day,
      warnAt: { day: today.warning.line, run: RUN_WARN_TOKENS },
    },
  };
};

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
      return Response.json(mischiefApiSpec());
    }

    if (capability === "thinkStatus") {
      return Response.json(await thinkStatus(env));
    }

    const body = await request.text();

    if (SCHEDULE_CAPABILITIES.has(capability)) {
      const scheduleId = scheduleIdOf(body);

      if (Option.isNone(scheduleId)) {
        return Response.json({ error: NO_SCHEDULE_ID }, { status: 400 });
      }

      const name = `${caller.success.iss}/${scheduleId.value}`;

      return await env.SCHEDULE.get(env.SCHEDULE.idFromName(name)).fetch(
        new Request(request.url, {
          body,
          headers: {
            "content-type": "application/json",
            [OBJECT_HEADER]: name,
          },
          method: request.method,
        })
      );
    }

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
        headers: {
          "content-type": "application/json",
          [OBJECT_HEADER]: `${caller.success.iss}/${runId.value}`,
        },
        method: request.method,
      })
    );
  },
} satisfies ExportedHandler<Env>;
