// @effect-diagnostics asyncFunction:off -- Durable Object RPC and storage alarms are Promise boundaries.
import { DurableObject } from "cloudflare:workers";
import { Effect, Option } from "effect";

import { deskHostClient } from "./desk-host-client.js";
import { validateDeskWake } from "./desk-wake-mail.js";
import type { DeskWake } from "./desk-wake-mail.js";
import { deskWaker } from "./desk-waker.js";
import { mailOnce } from "./escalation.js";
import type { Env } from "./plan-run-object.js";
import { POSTBOX_NAME } from "./postbox-object.js";

export class DeskWaker extends DurableObject<Env> {
  private readonly box = deskWaker({
    alarms: {
      clear: Effect.promise(async () => {
        await this.ctx.storage.deleteAlarm();
      }),
      set: (at) =>
        Effect.promise(async () => {
          await this.ctx.storage.setAlarm(at);
        }),
    },
    host: deskHostClient(this.env.MISCHIEF_DESK_WAKE_KEY),
    notify: (key, name, text) =>
      mailOnce({
        objectName: () => Option.some(`desk-wake/${name}`),
        postbox: () => this.env.POSTBOX.getByName(POSTBOX_NAME),
        storage: this.ctx.storage,
      })(name, "switchboard", key, text),
    storage: this.ctx.storage,
  });

  async wake(payload: DeskWake) {
    if (this.env.MISCHIEF_DESK_WAKE === "on") {
      await Effect.runPromise(
        validateDeskWake(payload).pipe(Effect.flatMap(this.box.wake))
      );
    }
  }

  async inspect() {
    return await Effect.runPromise(this.box.inspect);
  }

  override async alarm() {
    await Effect.runPromise(
      this.env.MISCHIEF_DESK_WAKE === "on" ? this.box.alarm : Effect.void
    );
  }
}
