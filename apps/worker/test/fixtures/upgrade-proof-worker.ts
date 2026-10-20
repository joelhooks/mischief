// @effect-diagnostics asyncFunction:off -- This test-only Worker exposes fixture seeding and observations around the production Durable Object's Promise surface.
import {
  applySqliteMigrations,
  SQLITE_MIGRATIONS,
} from "@earendil-works/pi-durable/storage/sqlite";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { Option } from "effect";

import { PlanRun as ProductionPlanRun } from "../../src/plan-run-object.js";
import type { Env } from "../../src/plan-run-object.js";
import { runIdOf } from "../../src/run-address.js";

export { Postbox } from "../../src/postbox-object.js";

export { Schedule } from "../../src/schedule-object.js";

export { ServiceTokenLedger } from "../../src/service-tokens.js";

export class PlanRun extends ProductionPlanRun {
  override async fetch(request: Request) {
    const route = new URL(request.url).pathname;
    const { storage } = this.ctx;

    if (route === "/upgradeSeed") {
      const schemas = storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'durable_schema'")
        .toArray();

      if (schemas.length === 0) {
        await applySqliteMigrations(
          new DurableObjectSqliteDatabase(storage),
          SQLITE_MIGRATIONS.filter(({ version }) => version === 1)
        );
      }

      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS upgrade_pi_opens (value INTEGER NOT NULL)"
      );

      return Response.json({ seeded: true });
    }

    if (route === "/upgradeInspect") {
      return Response.json({
        failedNotices: storage.sql
          .exec("SELECT key FROM mischief_journal WHERE key = 'done:failed'")
          .toArray(),
        opens: storage.sql
          .exec("SELECT COUNT(*) AS count FROM upgrade_pi_opens")
          .toArray(),
        runs: storage.sql.exec("SELECT state FROM mischief_runs").toArray(),
        versions: storage.sql
          .exec("SELECT version FROM durable_schema WHERE singleton = 1")
          .toArray(),
      });
    }

    return await super.fetch(request);
  }
}

export default {
  async fetch(request, env) {
    const runId = Option.getOrElse(
      runIdOf(await request.clone().text()),
      () => "bootstrap"
    );

    const id = env.PLAN_RUN.idFromName(runId);

    return await env.PLAN_RUN.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
