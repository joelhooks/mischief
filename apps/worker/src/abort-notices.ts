// @effect-diagnostics asyncFunction:off -- a Postbox Durable Object RPC call is a Promise API.
import type { SqlStorage } from "@mischief/plan-run";
import { Effect, Option } from "effect";

import { objectOf } from "./postbox-mail.js";
import type { Posted } from "./postbox-object.js";

export const abortNotices =
  (
    storage: SqlStorage,
    postbox: () => {
      readonly aborted: (
        objectName: string,
        reason: string
      ) => Promise<Posted<object>>;
    }
  ) =>
  (runId: string, reason: string) =>
    Option.match(objectOf(storage), {
      onNone: () =>
        Effect.die(
          `${runId} cannot announce aborted replies without its object name`
        ),
      onSome: (name) =>
        Effect.promise(async () => await postbox().aborted(name, reason)).pipe(
          Effect.flatMap((result) =>
            result.ok
              ? Effect.void
              : Effect.die(
                  `${runId} abort reply notices remain pending: ${result.reason}`
                )
          )
        ),
    });
