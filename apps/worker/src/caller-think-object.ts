// @effect-diagnostics asyncFunction:off -- Durable Object acquire and alarm handlers are Promise boundaries, matching PlanRun, Postbox and Schedule.
import { THINK_STREAM_TIMEOUT_MS } from "@mischief/thinking";
import { DurableObject } from "cloudflare:workers";
import { Effect, Option, Result } from "effect";

import { callerThinkHost } from "./caller-think-host.js";
import { callerThinkLedger, callerThinksFrom } from "./caller-thinks.js";
import { mailConfirmed } from "./escalation.js";
import { nameFor } from "./fleet-names.js";
import type { Env } from "./plan-run-object.js";
import { POSTBOX_NAME } from "./postbox-object.js";

export class CallerThinks extends DurableObject<Env> {
  private readonly ledger;
  private readonly host;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const configured = callerThinksFrom(env.MISCHIEF_CALLER_THINKS);

    if (Result.isFailure(configured)) {
      throw configured.failure;
    }

    this.ledger = callerThinkLedger(ctx.storage);
    const postbox = () => env.POSTBOX.getByName(POSTBOX_NAME);

    this.host = callerThinkHost({
      arm: (at) =>
        Effect.promise(async () => {
          const pending = await ctx.storage.getAlarm();

          if (pending === null || pending > at) {
            await ctx.storage.setAlarm(at);
          }
        }),
      clear: Effect.promise(async () => {
        await ctx.storage.deleteAlarm();
      }),
      ledger: this.ledger,
      send: (notice) =>
        mailConfirmed(
          {
            objectName: () => Option.some(notice.object_name),
            postbox,
            storage: ctx.storage,
          },
          notice.object_name,
          notice.to,
          `caller-share:${notice.serial}:${notice.to}`,
          notice.text
        ),
      share: configured.success,
      ttlMs: THINK_STREAM_TIMEOUT_MS + 60_000,
    });
  }

  async acquire(caller: string, id: string, objectName: string, key: string) {
    return await Effect.runPromise(
      this.host.acquire({
        caller,
        id,
        key,
        objectName,
        to: [...Option.toArray(nameFor(caller)), "pi-durable/desk"],
      })
    );
  }

  release(id: string) {
    this.ledger.release(id);
  }

  override async alarm() {
    await Effect.runPromise(
      this.host
        .alarm()
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `caller-share notice is still pending; the next alarm retries: ${error}`
            )
          )
        )
    );
  }
}
