import { DurableObject } from "cloudflare:workers";

import type { Env } from "./plan-run-object.js";

export class ServiceTokenLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS tokens (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL)"
    );
  }

  consume(jti: string, exp: number, now: number) {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM tokens WHERE exp < ?", now);

      const seen =
        this.ctx.storage.sql
          .exec("SELECT jti FROM tokens WHERE jti = ?", jti)
          .toArray().length > 0;

      if (!seen) {
        this.ctx.storage.sql.exec(
          "INSERT INTO tokens (jti, exp) VALUES (?, ?)",
          jti,
          exp
        );
      }

      return !seen;
    });
  }
}
