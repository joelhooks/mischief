import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Mail } from "@mischief/core";
import { Effect, Layer, Option, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { FetchHttpClient } from "effect/http";

import { attributeMail } from "../src/mail-attribution.js";
import { reachableMail } from "../src/mail-reach.js";
import { post, prepare, start } from "./workerd.js";

const DID = "did:web:agent-graph.driver.pi.ratking-fleet.invalid";

const OBJECT = `${DID}/reach-run`;

const CALL = { epoch: 0, key: "notify", runId: "reach-run", visit: 1 };

it.effect.prop(
  "a pending sealed message obeys the current reach after revocation, keeps its bytes, and carries attribution exactly once",
  {
    body: Arbitrary.schema(Schema.String),
    encrypted: Arbitrary.schema(Schema.Boolean),
    target: Arbitrary.schema(
      Schema.Literals(["agent-graph/driver", "joel-phone", "other/desk"])
    ),
  },
  ({ target, body, encrypted }) =>
    Effect.gen(function* history() {
      let config = JSON.stringify({ [DID]: [target] });
      const sent: string[] = [];
      let text = "";

      const recipientDid =
        target === "joel-phone"
          ? "did:web:joel-iphone.ratking-fleet.invalid"
          : `did:web:${target.replace("/", ".")}.pi.ratking-fleet.invalid`;

      const envelope = encrypted
        ? JSON.stringify({ aad: { recipientDid }, ciphertext: "stored bytes" })
        : JSON.stringify({ message: "stored bytes", to: target });

      const underlying = Layer.succeed(
        Mail,
        Mail.of({
          seal: (call) =>
            Effect.sync(() => {
              text = call.message;

              return { envelope, messageId: "stable-id" };
            }),
          send: (_call, sealed) =>
            Effect.sync(() => {
              sent.push(sealed.envelope);
            }),
        })
      );

      const layer = reachableMail(
        () => Option.some(OBJECT),
        () => config
      ).pipe(Layer.provide(underlying));

      yield* Mail.use((mail) =>
        Effect.gen(function* run() {
          const old = {
            envelope: encrypted
              ? JSON.stringify({
                  aad: { recipientDid },
                  ciphertext: "sealed before footer",
                })
              : JSON.stringify({ message: "sealed before footer", to: target }),
            messageId: "before-footer",
          };

          yield* mail.send(CALL, old);
          expect(text).toBe("");
          expect(sent).toStrictEqual([old.envelope]);

          const sealed = yield* mail.seal({
            ...CALL,
            message: attributeMail(OBJECT, body),
            to: target,
          });

          const footer = "Mischief caller: agent-graph/driver; run: reach-run";

          expect(
            text.split("\n").filter((line) => line === footer)
          ).toHaveLength(1);
          expect(text.endsWith(footer)).toBe(true);
          yield* mail.send(CALL, sealed);
          config = JSON.stringify({ [DID]: [] });
          const revoked = yield* Effect.result(mail.send(CALL, sealed));

          expect(Result.isFailure(revoked)).toBe(true);

          if (Result.isFailure(revoked)) {
            expect(revoked.failure.message).toContain("notify");
            expect(revoked.failure.message).toContain(
              encrypted && target === "joel-phone" ? "joel-iphone" : target
            );
            expect(revoked.failure.message).toContain("Allowed: none");
            expect(revoked.failure.message).toContain("Ask the Mischief desk");
          }

          const revokedOld = yield* Effect.result(mail.send(CALL, old));

          expect(Result.isFailure(revokedOld)).toBe(true);

          const next = yield* mail.seal({
            ...CALL,
            key: "next",
            message: body,
            to: target,
          });

          const nextRefused = yield* Effect.result(
            mail.send({ ...CALL, key: "next" }, next)
          );

          expect(Result.isFailure(nextRefused)).toBe(true);

          if (Result.isFailure(nextRefused)) {
            expect(nextRefused.failure.message).toContain(
              "Ask the Mischief desk"
            );
          }

          expect(sent).toStrictEqual([old.envelope, envelope]);
        })
      ).pipe(Effect.provide(layer));
    })
);

const planFor = (to: string, extra: readonly string[] = []) => ({
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [to, ...extra],
    thresholds: { judge: 0.8 },
  },
  goal: "Check caller mail reach",
  id: "reach",
  machine: {
    id: "reach",
    initial: "notify",
    states: {
      done: { type: "final" },
      notify: {
        meta: { step: { kind: "ask", message: "hello", to, writes: "reply" } },
        on: { replied: { target: "done" } },
      },
    },
  },
});

it.live(
  "submit refuses ungranted recipients and unused envelope names before a run exists, defaults to self, and accepts explicit grants",
  () =>
    Effect.gen(function* submitted() {
      const world = yield* prepare(30_000);
      yield* start(world);

      for (const [runId, plan] of [
        ["phone", planFor("joel-phone")],
        ["extra", planFor("driver", ["other/desk"])],
      ] as const) {
        const refused = yield* post(world, "submitPlan", { plan, runId });
        expect(refused.status).toBe(403);
        expect(JSON.stringify(refused.body)).toContain("Ask the Mischief desk");
        const absent = yield* post(world, "readRun", { runId });
        expect(absent.status).not.toBe(200);
      }

      for (const capability of ["submitPlan", "createSchedule"] as const) {
        const common = { escalateTo: "joel-phone", plan: planFor("driver") };

        const input =
          capability === "submitPlan"
            ? { ...common, runId: "escalation" }
            : {
                ...common,
                every: "1 minute",
                maxWakes: 1,
                scheduleId: "escalation",
              };

        const refused = yield* post(world, capability, input);

        expect(refused.status).toBe(403);
        expect(JSON.stringify(refused.body)).toContain("escalateTo");
        expect(JSON.stringify(refused.body)).toContain("joel-phone");
      }

      expect(
        (yield* post(world, "submitPlan", {
          plan: planFor("driver"),
          runId: "self",
        })).status
      ).toBe(200);

      const granted = yield* prepare(30_000, [], undefined, {
        mayMail: ["joel-phone"],
      });

      yield* start(granted);
      expect(
        (yield* post(granted, "submitPlan", {
          escalateTo: "joel-phone",
          plan: planFor("joel-phone"),
          runId: "granted",
        })).status
      ).toBe(200);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
    ),
  60_000
);
