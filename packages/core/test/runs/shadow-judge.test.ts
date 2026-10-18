import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { RunStore } from "../../src/runs/run-store.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { SHADOW_JUDGE, shadowJudge } from "../../src/steps/shadow-judge.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const gatePlan = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 10,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Let the shadow judge pick a branch",
  id: "gate",
  machine: {
    id: "gate",
    initial: "gate",
    states: {
      gate: {
        meta: { step: { kind: "judge", question: "Go or stop?" } },
        on: { go: { target: "went" }, stop: { target: "stopped" } },
      },
      stopped: { type: "final" },
      went: { type: "final" },
    },
  },
} as const;

const host = RunHost.make.pipe(
  Effect.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      shadowJudge,
      Thinker.unwired,
      Mail.unwired,
      Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
    )
  )
);

it.effect(
  "a shadow judge with no verdict parks the run, and the verdict from shadow/judge alone finishes it on the chosen branch",
  () =>
    Effect.gen(function* parked() {
      const runs = yield* host;
      const waiting = yield* runs.submit("gated", gatePlan);

      expect(waiting.status).toBe("waiting-for-reply");
      expect(waiting.awaiting).toStrictEqual([
        {
          key: "gate",
          messageId: "gated/gate#1",
          to: SHADOW_JUDGE,
          writes: null,
        },
      ]);

      const impostor = yield* Effect.flip(
        runs.deliver({
          body: '{"choice":"go"}',
          from: "desk/x",
          replyTo: "gated/gate#1",
        })
      );

      expect(impostor._tag).toBe("ReplyRefused");

      const done = yield* runs.deliver({
        body: '{"probabilities":{"go":0.9,"stop":0.1}}',
        from: SHADOW_JUDGE,
        replyTo: "gated/gate#1",
      });

      expect(done.status).toBe("done");
      expect(done.value).toBe("went");
    }).pipe(Effect.provide(RunStore.memory))
);

it.effect(
  "a bare choice from shadow/judge picks that branch, and a verdict that does not decode fails the step with the shape it wanted",
  () =>
    Effect.gen(function* decoded() {
      const runs = yield* host;

      yield* runs.submit("chosen", gatePlan);

      const stopped = yield* runs.deliver({
        body: '{"choice":"stop"}',
        from: SHADOW_JUDGE,
        replyTo: "chosen/gate#1",
      });

      expect(stopped.value).toBe("stopped");

      yield* runs.submit("garbled", gatePlan);

      const garbled = yield* runs.deliver({
        body: "go, probably",
        from: SHADOW_JUDGE,
        replyTo: "garbled/gate#1",
      });

      expect(garbled.status).not.toBe("done");
      expect(garbled.docs["failed:gate"]).toBe(true);
    }).pipe(Effect.provide(RunStore.memory))
);

it.effect(
  "a verdict naming an option the judge does not offer fails the step and lists the options it does",
  () =>
    Effect.gen(function* misMirrored() {
      const runs = yield* host;

      yield* runs.submit("mirrored", gatePlan);

      const wrong = yield* runs.deliver({
        body: '{"choice":"pass"}',
        from: SHADOW_JUDGE,
        replyTo: "mirrored/gate#1",
      });

      expect(wrong.status).not.toBe("done");
      expect(wrong.docs["failed:gate"]).toBe(true);

      const record = yield* RunStore.use((store) =>
        store.readJournal("mirrored")
      );

      expect(JSON.stringify([...record.values()])).toContain(
        'names \\"pass\\", which this judge does not offer'
      );
    }).pipe(Effect.provide(RunStore.memory))
);
