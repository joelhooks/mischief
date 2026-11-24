import { prepareDeployment } from "@rat-king/alchemy-nest";
import type { Declaration } from "@rat-king/alchemy-nest";
import { Effect, Path } from "effect";

import { peonVars } from "./peon-config.ts";

export const INSTANCE = "mischief";

const declaration: typeof Declaration.Type = {
  compatibility_date: "2026-09-01",
  compatibility_flags: [],
  durable_objects: {
    bindings: [
      { class_name: "PlanRun", name: "PLAN_RUN" },
      { class_name: "ServiceTokenLedger", name: "SERVICE_TOKENS" },
      { class_name: "Postbox", name: "POSTBOX" },
      { class_name: "Schedule", name: "SCHEDULE" },
      { class_name: "CallerThinks", name: "CALLER_THINKS" },
      { class_name: "Peon", name: "PEON" },
      { class_name: "PeonTemplates", name: "PEON_TEMPLATES" },
    ],
  },
  migrations: [
    { new_sqlite_classes: ["PlanRun", "ServiceTokenLedger"], tag: "v1" },
    { new_sqlite_classes: ["Postbox"], tag: "v2" },
    { new_sqlite_classes: ["Schedule"], tag: "v3" },
    { new_sqlite_classes: ["CallerThinks"], tag: "v4" },
    { new_sqlite_classes: ["Peon", "PeonTemplates"], tag: "v5-peons" },
  ],
  name: INSTANCE,
};

export interface BuildInput {
  readonly callers: string;
  readonly mailReach?: string;
  readonly peonGrants?: string;
  readonly commit: string;
  readonly did: string;
  readonly deskWakeSender?: string | undefined;
  readonly entry?: string;
  readonly judge: "jev" | "shadow";
  readonly mailbox: { readonly did: string; readonly url: string };
  readonly opusBridgeUrl?: string | undefined;
  readonly thinker: Thinker;
  readonly version: string;
  readonly workspace?:
    | {
        readonly mode: "off" | "on";
        readonly repos: string;
        readonly url: string;
      }
    | undefined;
}

export type Thinker =
  | { readonly model: "faux" }
  | { readonly model: "cliproxy"; readonly url: string };

const thinkerVars = (thinker: Thinker): Record<string, string> =>
  thinker.model === "cliproxy"
    ? { MISCHIEF_CLIPROXY_URL: thinker.url, MISCHIEF_MODEL: "cliproxy" }
    : { MISCHIEF_MODEL: "faux" };

export const buildWorker = ({
  callers,
  mailReach = "{}",
  peonGrants = "{}",
  commit,
  did,
  deskWakeSender,
  entry,
  judge,
  mailbox,
  opusBridgeUrl,
  thinker,
  version,
  workspace,
}: BuildInput) =>
  Effect.gen(function* buildMischiefWorker() {
    const path = yield* Path.Path;

    const peons = yield* peonVars;

    const vars = {
      ...peons,
      MISCHIEF_CALLERS: callers,
      MISCHIEF_CALLER_THINKS: "40",
      MISCHIEF_DID: did,
      MISCHIEF_GUARD_MS: "30000",
      MISCHIEF_HOLD_ALARM_TO: "agent-graph/desk,switchboard",
      MISCHIEF_JUDGE: judge,
      MISCHIEF_MAILBOX_DID: mailbox.did,
      MISCHIEF_MAILBOX_URL: mailbox.url,
      MISCHIEF_MAIL_REACH: mailReach,
      MISCHIEF_PEON_GRANTS: peonGrants,
      MISCHIEF_THINK_CONCURRENCY: "16",
      ...thinkerVars(thinker),
    };

    const workspaceVars =
      workspace === undefined
        ? vars
        : {
            ...vars,
            MISCHIEF_WORKSPACE: workspace.mode,
            MISCHIEF_WORKSPACE_BRIDGE_URL: workspace.url,
            MISCHIEF_WORKSPACE_REPOS: workspace.repos,
          };

    const workerVars: typeof workspaceVars & {
      MISCHIEF_OPUS_BRIDGE_URL?: string;
      MISCHIEF_DESK_WAKE?: string;
      MISCHIEF_DESK_WAKE_SENDER?: string;
    } = { ...workspaceVars };

    if (opusBridgeUrl !== undefined && opusBridgeUrl.trim() !== "") {
      workerVars.MISCHIEF_OPUS_BRIDGE_URL = opusBridgeUrl;
    }

    if (deskWakeSender !== undefined) {
      workerVars.MISCHIEF_DESK_WAKE = "on";
      workerVars.MISCHIEF_DESK_WAKE_SENDER = deskWakeSender;
    }

    return yield* prepareDeployment(
      entry ?? path.resolve(import.meta.dirname, "../worker/src/worker.ts"),
      {
        ...declaration,
        durable_objects: {
          bindings: [
            ...declaration.durable_objects.bindings,
            ...(deskWakeSender === undefined
              ? []
              : [{ class_name: "DeskWaker", name: "DESK_WAKER" }]),
            { class_name: "WatchObject", name: "WATCH" },
          ],
        },
        migrations: [
          ...declaration.migrations,
          ...(deskWakeSender === undefined
            ? []
            : [{ new_sqlite_classes: ["DeskWaker"], tag: "v6-desk-waker" }]),
          { new_sqlite_classes: ["WatchObject"], tag: "v7-watch" },
        ],
      },
      { commit, vars: workerVars, version }
    );
  });
