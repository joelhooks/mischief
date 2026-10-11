// @effect-diagnostics asyncFunction:off -- the fake ledger implements a Durable Object stub's Promise RPC method.
import { expect, it } from "@effect/vitest";
import { ReplayAuthority } from "@rat-king/mailbox-client/auth";
import { Effect, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { replayLedger } from "../src/replay-ledger.js";

const Call = Schema.Struct({
  broken: Schema.Boolean,
  iss: Schema.Literals(["did:web:a", "did:web:b"]),
  jti: Schema.Literals(["j-0000000000000001", "j-0000000000000002"]),
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
      const model = new Set<string>();

      for (const call of calls) {
        const ledger = replayLedger((issuer) => ({
          consume: async (jti, _exp, nowSeconds) => {
            seenNow.push(nowSeconds);

            if (call.broken) {
              throw new Error("storage reset");
            }

            const own = stored.get(issuer) ?? new Set<string>();

            stored.set(issuer, own);

            const fresh = !own.has(jti);

            own.add(jti);

            return await Promise.resolve(fresh);
          },
        }));

        const result = yield* Effect.result(
          ReplayAuthority.use((replay) =>
            replay.consume(
              {
                aud: "did:web:mischief#mischief",
                exp: Math.floor(call.now / 1000) + 30,
                iat: Math.floor(call.now / 1000),
                iss: call.iss,
                jti: call.jti,
                lxm: "sh.mschf.mischief.inspectRun",
              },
              call.now
            )
          ).pipe(Effect.provide(ledger))
        );

        expect(seenNow.at(-1)).toBe(Math.floor(call.now / 1000));

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
