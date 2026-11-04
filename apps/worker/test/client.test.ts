import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { makeClient } from "@mischief/client";
import { Identity, PrivateJwk } from "@rat-king/mailbox-client";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { AUDIENCE, prepare, start } from "./workerd.js";

const exportKey: (
  format: "jwk",
  key: CryptoKey
) => Promise<ArrayBuffer | JsonWebKey> = crypto.subtle.exportKey.bind(
  crypto.subtle
);

const plan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 1,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Wait for an answer without mailing anyone",
  id: "first-plan",
  machine: {
    id: "first-plan",
    initial: "question",
    states: {
      done: { type: "final" },
      question: {
        meta: {
          step: { kind: "ask-joel", question: "Finish the first plan?" },
        },
        on: { no: { target: "done" }, yes: { target: "done" } },
      },
    },
  },
};

it.live(
  "the packaged client submits, repeatedly inspects with fresh tokens, reads its receipt and aborts on workerd",
  () =>
    Effect.gen(function* roundTrip() {
      const world = yield* prepare(30_000);
      yield* start(world);

      const signing = yield* Effect.promise(
        exportKey.bind(undefined, "jwk", world.driver.key)
      );

      const key = yield* Schema.decodeUnknownEffect(PrivateJwk)(signing);

      const identity = yield* Schema.decodeUnknownEffect(Identity)({
        agreement: key,
        did: world.driver.did,
        signing: key,
      });

      const client = yield* makeClient(
        { audience: AUDIENCE, endpoint: `http://127.0.0.1:${world.port}` },
        identity
      );

      const submitted = yield* client.submitPlan({
        plan,
        runId: "client-first-plan",
      });

      expect(submitted.runId).toBe("client-first-plan");
      const first = yield* client.inspectRun({ runId: submitted.runId });
      const second = yield* client.inspectRun({ runId: submitted.runId });
      expect([first.runId, second.runId]).toEqual([
        submitted.runId,
        submitted.runId,
      ]);
      const receipt = yield* client.readRun({ runId: submitted.runId });
      expect(receipt.plan.id).toBe("first-plan");

      const schedule = yield* client.createSchedule({
        every: "1 minute",
        maxWakes: 1,
        plan,
        scheduleId: "client-schedule",
      });

      const inspectedSchedule = yield* client.inspectSchedule({
        scheduleId: schedule.scheduleId,
      });

      expect(inspectedSchedule.scheduleId).toBe("client-schedule");
      expect(
        (yield* client.completeSchedule({ scheduleId: schedule.scheduleId }))
          .ended?.reason
      ).toBe("completed");

      const refusedReply = yield* client
        .deliverReply({
          body: "No ask exists for this reply",
          replyTo: `${submitted.runId}/missing#1`,
        })
        .pipe(Effect.flip);

      expect(refusedReply._tag).toBe("ReplyRefused");

      const aborted = yield* client.abortRun({
        reason: "Client round-trip complete",
        runId: submitted.runId,
      });

      expect(aborted.status).toBe("aborted");
      expect(
        (yield* client.inspectRun({ runId: submitted.runId })).status
      ).toBe("aborted");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
    ),
  60_000
);
