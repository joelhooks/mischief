import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { ProviderUnavailable } from "../../src/steps/provider-unavailable.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const askPlan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: ["desk/owner"],
    thresholds: { judge: 0.8 },
  },
  goal: "Ask once",
  id: "asking",
  machine: {
    id: "asking",
    initial: "ask",
    states: {
      ask: {
        meta: {
          step: {
            kind: "ask",
            message: "ready?",
            to: "desk/owner",
            writes: "ready",
          },
        },
        on: { replied: { target: "end" } },
      },
      end: { type: "final" },
    },
  },
};

const WorldSchema = Schema.Struct({
  outages: Schema.Array(
    Schema.Struct({
      restart: Schema.Boolean,
      stage: Schema.Literals(["seal", "send"]),
    })
  ).check(Schema.isMaxLength(4)),
});

const timedOut = (key: string, call: string) =>
  new ProviderUnavailable({
    cause: "timeout",
    error: `${call} got no answer before its deadline`,
    key,
    provider: "postbox",
    status: null,
  });

it.effect.prop(
  "a Postbox outage during an ask holds the run waiting-for-provider without journaling a failure, and each resume finishes the ask with one seal and one delivered envelope",
  { world: Arbitrary.schema(WorldSchema) },
  ({ world }) =>
    Effect.gen(function* mailOutage() {
      const remaining = { outages: [...world.outages] };
      const sealed: string[] = [];
      const sent: string[] = [];

      const outage = (stage: "seal" | "send") => {
        const [next, ...rest] = remaining.outages;

        if (next?.stage !== stage) {
          return false;
        }

        remaining.outages = rest;

        return true;
      };

      const mail = Layer.succeed(
        Mail,
        Mail.of({
          seal: ({ key }) =>
            Effect.suspend(() => {
              if (outage("seal")) {
                return Effect.fail(timedOut(key, "Postbox.seal"));
              }

              sealed.push(key);

              return Effect.succeed({
                envelope: `sealed-${sealed.length}`,
                messageId: `message-${sealed.length}`,
              });
            }),
          send: ({ key }, { envelope }) =>
            Effect.suspend(() => {
              if (outage("send")) {
                return Effect.fail(timedOut(key, "Postbox.send"));
              }

              sent.push(envelope);

              return Effect.void;
            }),
        })
      );

      const hostNow = RunHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            mail,
            Judge.unwired,
            Thinker.unwired,
            Layer.succeed(
              Operator,
              Operator.of({
                held: () => Effect.void,
                notify: () => Effect.void,
              })
            )
          )
        )
      );

      let runs = yield* hostNow;
      let report = yield* runs.submit("asking", askPlan);
      let holds = 0;

      while (report.status === "waiting-for-provider") {
        holds += 1;

        expect(holds).toBeLessThanOrEqual(world.outages.length);
        expect(report.failures ?? []).toStrictEqual([]);
        expect(
          report.held?.map(({ cause, key, provider }) => ({
            cause,
            key,
            provider,
          }))
        ).toStrictEqual([
          { cause: "timeout", key: "ask", provider: "postbox" },
        ]);

        if (world.outages[holds - 1]?.restart === true) {
          runs = yield* hostNow;
        }

        report = yield* runs.resume("asking");
      }

      expect(report.status).toBe("waiting-for-reply");
      expect(report.failures ?? []).toStrictEqual([]);
      expect(sealed, "a sealed ask is never sealed again").toStrictEqual([
        "ask",
      ]);
      expect(
        sent,
        "the one delivery carries the stored sealed bytes"
      ).toStrictEqual(["sealed-1"]);
    }).pipe(Effect.provide(Layer.fresh(RunStore.memory))),
  { arbitrary: { runs: 60 } }
);
