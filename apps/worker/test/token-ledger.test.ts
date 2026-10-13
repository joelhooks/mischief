import { expect, it } from "@effect/vitest";
import type { SqlStorage } from "@mischief/plan-run";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Effect, Option, Schema } from "effect";

import { TOKENS, spendToken } from "../src/token-ledger.js";

const LIFE = 60;

const Step = Schema.Union([
  Schema.Struct({
    durable: Schema.Boolean,
    jti: Schema.Literals(["j-1", "j-2", "j-3"]),
    kind: Schema.Literal("spend"),
    wait: Schema.Int.check(Schema.isBetween({ maximum: 40, minimum: 0 })),
  }),
  Schema.Struct({ kind: Schema.Literal("restart") }),
]);

const decodeRow = Schema.decodeUnknownOption(
  Schema.Struct({ jti: Schema.String })
);

const storedAt = (storage: SqlStorage, now: number) =>
  storage.sql
    .exec("SELECT jti FROM tokens WHERE exp >= ?", now)
    .toArray()
    .flatMap((row) => Option.toArray(decodeRow(row)))
    .map(({ jti }) => jti)
    .toSorted();

const liveAt = (until: ReadonlyMap<string, number>, now: number) =>
  [...until].flatMap(([jti, at]) => (at >= now ? [jti] : [])).toSorted();

it.effect.prop(
  "a write token is spent once for its whole life across restarts, a read token once per incarnation, and reads never write the durable ledger",
  { steps: Schema.Array(Step).check(Schema.isMaxLength(24)) },
  ({ steps }) =>
    Effect.sync(() => {
      const storage = nodeSqlStorage(":memory:");

      storage.sql.exec(TOKENS);

      let memory = new Map<string, number>();
      let now = 1_000_000;

      const durableUntil = new Map<string, number>();
      const heldUntil = new Map<string, number>();

      for (const step of steps) {
        if (step.kind === "restart") {
          memory = new Map();
          heldUntil.clear();

          continue;
        }

        now += step.wait;

        const exp = now + LIFE;

        const fresh = spendToken(storage, memory, {
          durable: step.durable,
          exp,
          jti: step.jti,
          now,
        });

        const spentDurably = (durableUntil.get(step.jti) ?? -1) >= now;
        const spentHere = (heldUntil.get(step.jti) ?? -1) >= now;

        expect(
          fresh,
          `${step.jti} (${step.durable ? "write" : "read"}) at ${now}`
        ).toBe(!(spentDurably || spentHere));

        if (fresh) {
          (step.durable ? durableUntil : heldUntil).set(step.jti, exp);
        }

        expect(
          storedAt(storage, now),
          "the durable ledger holds exactly the live write tokens; a read wrote to it"
        ).toStrictEqual(liveAt(durableUntil, now));
      }
    }),
  { arbitrary: { runs: 300 } }
);
