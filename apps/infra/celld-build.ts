import { prepareDeployment } from "@rat-king/alchemy-nest";
import type { Declaration } from "@rat-king/alchemy-nest";
import { Effect, Path } from "effect";

export const INSTANCE = "mischief";

export const declaration: typeof Declaration.Type = {
  compatibility_date: "2026-09-01",
  compatibility_flags: [],
  durable_objects: {
    bindings: [
      { class_name: "PlanRun", name: "PLAN_RUN" },
      { class_name: "ServiceTokenLedger", name: "SERVICE_TOKENS" },
      { class_name: "Postbox", name: "POSTBOX" },
    ],
  },
  migrations: [
    { new_sqlite_classes: ["PlanRun", "ServiceTokenLedger"], tag: "v1" },
    { new_sqlite_classes: ["Postbox"], tag: "v2" },
  ],
  name: INSTANCE,
};

export interface BuildInput {
  readonly callers: string;
  readonly commit: string;
  readonly did: string;
  readonly mailbox: { readonly did: string; readonly url: string };
  readonly version: string;
}

export const buildWorker = ({
  callers,
  commit,
  did,
  mailbox,
  version,
}: BuildInput) =>
  Effect.gen(function* buildMischiefWorker() {
    const path = yield* Path.Path;

    return yield* prepareDeployment(
      path.resolve(import.meta.dirname, "../worker/src/worker.ts"),
      declaration,
      {
        commit,
        vars: {
          MISCHIEF_CALLERS: callers,
          MISCHIEF_DID: did,
          MISCHIEF_GUARD_MS: "30000",
          MISCHIEF_JUDGE: "shadow",
          MISCHIEF_MAILBOX_DID: mailbox.did,
          MISCHIEF_MAILBOX_URL: mailbox.url,
          MISCHIEF_MODEL: "faux",
        },
        version,
      }
    );
  });
