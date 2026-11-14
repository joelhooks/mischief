import * as Cloudflare from "@alchemy.run/cloudflare";
import { localState, Stack } from "alchemy";
import { Config, Effect, FileSystem, Path } from "effect";

import { callersFromConfig } from "./callers.ts";
import { peonVars } from "./peon-config.ts";

export const WORKER_NAME = "mischief";

export const cloudflare = Stack(
  "mischief-cf",
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* mischief() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const { callers, did, mailReach, peonGrants } = yield* callersFromConfig;
    const peons = yield* peonVars;

    const script = yield* fs.readFileString(
      path.resolve(import.meta.dirname, "../worker/dist/worker.js")
    );

    const peonKey =
      peons.MISCHIEF_PEON_BOXES === "on"
        ? { MISCHIEF_BOX_KEY: Config.Redacted("MISCHIEF_BOX_KEY") }
        : undefined;

    const worker = yield* Cloudflare.Worker("mischief", {
      bundle: false,
      compatibility: { date: "2026-09-01", flags: [] },
      env: {
        ...peons,
        ...peonKey,
        CALLER_THINKS: Cloudflare.DurableObject("CALLER_THINKS", {
          className: "CallerThinks",
        }),
        MISCHIEF_CALLERS: callers,
        MISCHIEF_DID: did,
        MISCHIEF_GUARD_MS: "30000",
        MISCHIEF_MAIL_REACH: mailReach,
        MISCHIEF_MODEL: "faux",
        MISCHIEF_PEON_GRANTS: peonGrants,
        PEON: Cloudflare.DurableObject("PEON", { className: "Peon" }),
        PEON_TEMPLATES: Cloudflare.DurableObject("PEON_TEMPLATES", {
          className: "PeonTemplates",
        }),
        PLAN_RUN: Cloudflare.DurableObject("PLAN_RUN", {
          className: "PlanRun",
        }),
        SERVICE_TOKENS: Cloudflare.DurableObject("SERVICE_TOKENS", {
          className: "ServiceTokenLedger",
        }),
      },
      name: WORKER_NAME,
      script,
      workersDev: { enabled: true, previewsEnabled: false },
    });

    return { workerUrl: worker.url };
  }).pipe(Effect.orDie)
);

export default cloudflare;
