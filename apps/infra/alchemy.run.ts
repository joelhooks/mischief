import { localState, Stack } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, FileSystem, Path } from "effect";

export const WORKER_NAME = "mischief";

export const cloudflare = Stack(
  "mischief-cf",
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* mischief() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const script = yield* fs.readFileString(
      path.resolve(import.meta.dirname, "../worker/dist/worker.js")
    );

    const worker = yield* Cloudflare.Worker("mischief", {
      bundle: false,
      compatibility: { date: "2026-09-01", flags: [] },
      env: {
        MISCHIEF_DESK: yield* Config.String("MISCHIEF_DESK").pipe(
          Config.withDefault("mischief")
        ),
        MISCHIEF_GUARD_MS: "30000",
        MISCHIEF_MODEL: "faux",
        MISCHIEF_TOKEN: yield* Config.Redacted("MISCHIEF_TOKEN"),
        PLAN_RUN: Cloudflare.DurableObject("PLAN_RUN", {
          className: "PlanRun",
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
