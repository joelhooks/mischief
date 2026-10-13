// @effect-diagnostics asyncFunction:off -- the fake ledger implements a Durable Object stub's Promise RPC method.
import { expect, it } from "@effect/vitest";
import { ReplayAuthority } from "@rat-king/mailbox-client/auth";
import { Effect, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { READ_ONLY, replayLedger } from "../src/replay-ledger.js";

const Call = Schema.Struct({
  broken: Schema.Boolean,
  iss: Schema.Literals(["did:web:a", "did:web:b"]),
  jti: Schema.Literals(["j-0000000000000001", "j-0000000000000002"]),
  lxm: Schema.Literals([
    "sh.mschf.mischief.inspectRun",
    "sh.mschf.mischief.submitPlan",
  ]),
  now: Schema.Int.check(
    Schema.isBetween({ maximum: 9_999_999, minimum: 1_000_000 })
  ),
});

it.effect.prop(
  "the ledger serves each issuer's jti once, refuses a reuse with 401, and denies with 503 when the ledger itself fails",
  {
    calls: Arbitrary.schema(Schema.Array(Call).check(Schema.isMaxLength(12))),
  },
  ({ calls }) =>
    Effect.gen(function* property() {
      const stored = new Map<string, Set<string>>();
      const seenNow: number[] = [];
      const seenDurable: boolean[] = [];
      const model = new Set<string>();

      for (const call of calls) {
        const ledger = replayLedger(
          (issuer) => ({
            consume: async (jti, _exp, nowSeconds, durable) => {
              seenNow.push(nowSeconds);
              seenDurable.push(durable);

              if (call.broken) {
                throw new Error("storage reset");
              }

              const own = stored.get(issuer) ?? new Set<string>();

              stored.set(issuer, own);

              const fresh = !own.has(jti);

              own.add(jti);

              return await Promise.resolve(fresh);
            },
          }),
          READ_ONLY
        );

        const result = yield* Effect.result(
          ReplayAuthority.use((replay) =>
            replay.consume(
              {
                aud: "did:web:mischief#mischief",
                exp: Math.floor(call.now / 1000) + 30,
                iat: Math.floor(call.now / 1000),
                iss: call.iss,
                jti: call.jti,
                lxm: call.lxm,
              },
              call.now
            )
          ).pipe(Effect.provide(ledger))
        );

        expect(seenNow.at(-1)).toBe(Math.floor(call.now / 1000));
        expect(
          seenDurable.at(-1),
          "only a write capability's token is spent in the durable ledger"
        ).toBe(call.lxm === "sh.mschf.mischief.submitPlan");

        const key = `${call.iss} ${call.jti}`;

        const reused = model.has(key);

        if (!call.broken) {
          model.add(key);
        }

        const served = reused ? 401 : 200;

        const expected = call.broken ? 503 : served;

        const status = Result.isSuccess(result) ? 200 : result.failure.status;

        expect([call, status]).toStrictEqual([call, expected]);
      }
    })
);

it("only reads skip the durable ledger: the read-only set names exactly the inspecting capabilities", () => {
  expect(
    [...READ_ONLY].toSorted(),
    "a write marked readOnly would lose durable replay protection"
  ).toStrictEqual(
    [
      "sh.mschf.mischief.inspectRun",
      "sh.mschf.mischief.inspectSchedule",
      "sh.mschf.mischief.openApi",
      "sh.mschf.mischief.readRun",
    ].toSorted()
  );
});
