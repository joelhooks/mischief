import { expect, it } from "@effect/vitest";
import { ThinkStatusSchema, thinkStatus, ThinkTelemetry } from "@mischief/core";
import { mischiefApiSpec } from "@mischief/plan-run";
import type { SqlStorage } from "@mischief/plan-run";
import { nodeSqlStorage } from "@mischief/plan-run/node";
import { Clock, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";

import { thinkStatusHttp } from "../src/think-status-http.js";
import { dayTotals, dayWarning, tally } from "../src/think-tally.js";
import { thinkTelemetry } from "../src/think-telemetry.js";

const projected = Effect.fnUntraced(function* projectStatus(
  telemetry: ThinkTelemetry["Service"]
) {
  const clock = yield* Clock.Clock;

  return yield* Effect.acquireUseRelease(
    Effect.sync(() =>
      thinkStatusHttp({
        read: telemetry.read.pipe(Effect.provideService(Clock.Clock, clock)),
      })
    ),
    ({ handler }) =>
      Effect.promise(
        handler.bind(
          null,
          new Request("http://mischief/thinkStatus", {
            body: "{}",
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
          undefined
        )
      ).pipe(
        Effect.flatMap((response) =>
          Effect.promise(response.text.bind(response)).pipe(
            Effect.map((text) => ({ status: response.status, text }))
          )
        )
      ),
    ({ dispose }) => Effect.promise(dispose)
  );
});

const readDay = (storage: SqlStorage) => (day: string) =>
  Effect.sync(() => ({
    ...dayTotals(storage, day),
    warning: dayWarning(storage, day),
  }));

it.effect(
  "the projected response preserves the old handler's bytes for empty and populated storage fixtures",
  () =>
    Effect.gen(function* golden() {
      yield* TestClock.setTime(0);

      const storage = nodeSqlStorage(":memory:");

      const empty = yield* projected(
        thinkTelemetry({ model: "faux", readDay: readDay(storage) })
      );

      expect(empty.status).toBe(200);
      expect(empty.text).toBe(
        '{"default":{"model":"gpt-6.1-sol","thinking":"medium","review":"2026-11-15","source":"THINK_DEFAULT in @mischief/thinking; design ledger 2026-10-16"},"host":{"model":"faux","wired":true},"today":{"calls":0,"tokens":0,"warning":{"line":1500000,"median":null,"multiple":2,"sampleDays":0},"day":"1970-01-01","warnAt":{"call":150000,"day":1500000,"stepRepeats":3}}}'
      );
      tally(storage, "1969-12-30", "previous", "think", 2_000_000);
      tally(storage, "1969-12-31", "previous", "think", 4_000_000);
      tally(storage, "1970-01-01", "current", "think", 42);

      const populated = yield* projected(
        thinkTelemetry({ model: "faux", readDay: readDay(storage) })
      );

      expect(populated.status).toBe(200);
      expect(populated.text).toBe(
        '{"default":{"model":"gpt-6.1-sol","thinking":"medium","review":"2026-11-15","source":"THINK_DEFAULT in @mischief/thinking; design ledger 2026-10-16"},"host":{"model":"faux","wired":true},"today":{"calls":1,"tokens":42,"warning":{"line":6000000,"median":3000000,"multiple":2,"sampleDays":2},"day":"1970-01-01","warnAt":{"call":150000,"day":6000000,"stepRepeats":3}}}'
      );
    })
);

const Tokens = Schema.Int.check(
  Schema.isBetween({ maximum: 10_000_000, minimum: 0 })
);

it.effect.prop(
  "generated stored day tallies survive the HTTP schema and expose the day-warning line",
  {
    history: Schema.Array(Tokens).check(Schema.isMaxLength(10)),
    tokens: Tokens,
  },
  ({ history, tokens }) =>
    Effect.gen(function* dayTelemetry() {
      yield* TestClock.setTime(0);

      const storage = nodeSqlStorage(":memory:");

      for (const [index, amount] of history.entries()) {
        tally(storage, `1969-12-${10 + index}`, "history", "think", amount);
      }

      tally(storage, "1970-01-01", "current", "think", tokens);

      const warning = dayWarning(storage, "1970-01-01");

      const response = yield* projected(
        thinkTelemetry({ model: "faux", readDay: readDay(storage) })
      );

      expect(response.status).toBe(200);

      const status = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ThinkStatusSchema)
      )(response.text);

      expect(status.today.calls).toBe(1);
      expect(status.today.tokens).toBe(tokens);
      expect(status.today.warning).toStrictEqual(warning);
      expect(status.today.warnAt).toStrictEqual({
        call: 150_000,
        day: warning.line,
        stepRepeats: 3,
      });
      expect(status.today.day).toBe("1970-01-01");
    }),
  { arbitrary: { runs: 100, seed: "think-status" } }
);

it.effect(
  "a local CLI reports missing host telemetry instead of inventing a day tally",
  () =>
    Effect.gen(function* unavailable() {
      const error = yield* thinkStatus
        .handler({})
        .pipe(Effect.flip, Effect.provide(ThinkTelemetry.unavailable));

      expect(error._tag).toBe("ThinkTelemetryUnavailable");
      expect(error.reason).toContain("POST /thinkStatus");
    })
);

it("publishes the read-only capability and its day-warning fields in OpenAPI", () => {
  const spec = mischiefApiSpec();

  expect(spec.paths).toHaveProperty("/thinkStatus");
  expect(JSON.stringify(spec.paths?.["/thinkStatus"])).toContain("sampleDays");
  expect(thinkStatus.contract.annotations).toMatchObject({
    idempotent: true,
    readOnly: true,
  });
});
