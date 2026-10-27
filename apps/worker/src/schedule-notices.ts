import { ScheduleNotices } from "@mischief/core";
import type { SqlStorage } from "@mischief/plan-run";
import { Effect, Option } from "effect";

import { mailOnce } from "./escalation.js";
import { nameFor } from "./fleet-names.js";
import type { PostboxRpc } from "./postbox-mail.js";

export interface NoticePorts {
  readonly objectName: () => Option.Option<string>;
  readonly postbox: () => Pick<PostboxRpc, "seal" | "send">;
  readonly storage: SqlStorage;
}

export const callerOf = (objectName: string) =>
  nameFor(objectName.slice(0, objectName.lastIndexOf("/")));

export const scheduleNotices = (ports: NoticePorts) =>
  ScheduleNotices.of({
    ended: ({ escalateTo, key, scheduleId, text }) => {
      const to = Option.fromNullishOr(escalateTo).pipe(
        Option.orElse(() => Option.flatMap(ports.objectName(), callerOf))
      );

      return Option.match(to, {
        onNone: () =>
          Effect.logWarning(
            `schedule ${scheduleId} ended but has no mailbox to tell: it has no escalateTo and its caller's DID names no Rat King mailbox. inspectSchedule {"scheduleId": "${scheduleId}"} shows why it ended; create it with escalateTo to be told next time`
          ),
        onSome: (target) => mailOnce(ports)(scheduleId, target, key, text),
      });
    },
  });
