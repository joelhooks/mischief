import { prepareDeployment } from "@rat-king/alchemy-nest";
import type { Declaration } from "@rat-king/alchemy-nest";
import { Effect, Path } from "effect";

export const INSTANCE = "mischief";

export const declaration: typeof Declaration.Type = {
  compatibility_date: "2026-09-01",
  compatibility_flags: [],
  durable_objects: {
    bindings: [{ class_name: "PlanRun", name: "PLAN_RUN" }],
  },
  migrations: [{ new_sqlite_classes: ["PlanRun"], tag: "v1" }],
  name: INSTANCE,
};

export interface BuildInput {
  readonly commit: string;
  readonly desk: string;
  readonly version: string;
}

export const buildWorker = ({ commit, desk, version }: BuildInput) =>
  Effect.gen(function* buildMischiefWorker() {
    const path = yield* Path.Path;

    return yield* prepareDeployment(
      path.resolve(import.meta.dirname, "../worker/src/worker.ts"),
      declaration,
      {
        commit,
        vars: {
          MISCHIEF_DESK: desk,
          MISCHIEF_GUARD_MS: "30000",
          MISCHIEF_MODEL: "faux",
        },
        version,
      }
    );
  });
