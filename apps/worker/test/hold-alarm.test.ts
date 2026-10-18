import { expect, it } from "@effect/vitest";
import { HeldSchema } from "@mischief/core";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Option, Schema } from "effect";

import {
  alarmOnHolds,
  fixEscalationAtFirstSubmit,
  holdAlarmTargets,
} from "../src/escalation.js";

it.effect.prop(
  "a cap alarm reaches the run's escalation target and every host target, once per unique name, with sealed bytes preserved on replay",
  {
    held: HeldSchema,
    target: Schema.Literals(["desk/owner", "desk/host", "none"]),
  },
  ({ held, target }) =>
    Effect.gen(function* alarmRecipients() {
      const storage = nodeSqlStorage(":memory:");
      const seals: { readonly body: string; readonly to: string }[] = [];
      const sent: string[] = [];

      fixEscalationAtFirstSubmit(
        storage,
        JSON.stringify(target === "none" ? {} : { escalateTo: target })
      );

      const postbox = () => ({
        // @effect-diagnostics-next-line asyncFunction:off -- the fake seal mirrors Promise-based Durable Object RPC.
        seal: async (objectName: string, to: string, body: string) => {
          await Promise.resolve();
          seals.push({ body, to });

          return {
            envelope: JSON.stringify({
              body,
              nonce: seals.length,
              objectName,
              to,
            }),
            messageId: String(seals.length),
            ok: true as const,
          };
        },
        // @effect-diagnostics-next-line asyncFunction:off -- the fake send mirrors Promise-based Durable Object RPC.
        send: async (envelope: string) => {
          await Promise.resolve();
          sent.push(envelope);

          return { ok: true as const };
        },
      });

      const announce = () =>
        alarmOnHolds(
          { objectName: () => Option.some("object-1"), postbox, storage },
          holdAlarmTargets(" desk/host,desk/backup,desk/host, ")
        );

      yield* announce()("held-run", [held], 6, "hold-alarm");

      const originals = [...sent];

      yield* announce()("held-run", [held], 6, "hold-alarm");

      expect(seals.map(({ to }) => to).toSorted()).toStrictEqual(
        [
          ...new Set([
            "desk/host",
            "desk/backup",
            ...(target === "none" ? [] : [target]),
          ]),
        ].toSorted()
      );
      expect(sent).toStrictEqual([...originals, ...originals]);

      for (const { body } of seals) {
        expect(body).toContain("held-run");
        expect(body).toContain(held.provider);
        expect(body).toContain(String(held.status ?? "unknown"));
        expect(body).toContain(held.error);
        expect(body).toContain("6 automatic provider resume attempts");
      }
    }),
  { arbitrary: { runs: 30 } }
);
