import { DurableObject } from "cloudflare:workers";

import type { Env } from "./plan-run-object.js";
import { TOKENS, spendToken } from "./token-ledger.js";

export class ServiceTokenLedger extends DurableObject<Env> {
  private readonly memory = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.storage.sql.exec(TOKENS);
  }

  consume(jti: string, exp: number, now: number, durable = true) {
    return spendToken(this.ctx.storage, this.memory, {
      durable,
      exp,
      jti,
      now,
    });
  }
}
