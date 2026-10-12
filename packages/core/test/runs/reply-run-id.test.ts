import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";

import { RunHost } from "../../src/runs/host.js";
import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";

const unused = () => Effect.die("this plan only asks");

const services = Layer.mergeAll(
  NodeCrypto.layer,
  RunStore.memory,
  Layer.succeed(
    Thinker,
    Thinker.of({ decide: unused, elaborate: unused, think: unused })
  ),
  Layer.succeed(Judge, Judge.of({ choose: unused })),
  Layer.succeed(
    Mail,
    Mail.of({
      seal: ({ runId }) =>
        Effect.succeed({
          envelope: "{}",
          messageId: runId === "cc2" ? "3mxoabjvtfwka" : "3mxotherrunid",
        }),
      send: () => Effect.void,
    })
  ),
  Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
);

const asking = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 20,
    maxThinking: "low",
    models: ["sol"],
    names: ["partner/desk"],
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
            message: "landed?",
            to: "partner/desk",
            writes: "answer",
          },
        },
        on: { replied: { target: "end" } },
      },
      end: { type: "final" },
    },
  },
};

const bare = {
  body: "landed as ee420d40",
  from: "partner/desk",
  replyTo: "3mxoabjvtfwka",
};

const line = (runId?: string) =>
  runId === undefined ? bare : { ...bare, runId };

it.effect(
  "a relayed reply may name its run; a wrong run is refused with the right one, and the right or no runId delivers",
  () =>
    Effect.gen(function* relayed() {
      const host = yield* RunHost.make;

      yield* host.submit("cc2", asking);
      yield* host.submit("other", asking);

      const wrong = yield* Effect.exit(host.deliver(line("other")));

      expect(Exit.isFailure(wrong)).toBe(true);
      expect(JSON.stringify(wrong)).toContain(
        'Send it again with runId \\"cc2\\"'
      );
      expect((yield* host.inspect("cc2")).status).toBe("waiting-for-reply");

      const right = yield* host.deliver(line("cc2"));

      expect(right.status).toBe("done");
      expect(right.docs.answer).toBe("landed as ee420d40");
    }).pipe(Effect.provide(services))
);

it.effect("a relayed reply without runId still finds its run", () =>
  Effect.gen(function* unnamed() {
    const host = yield* RunHost.make;

    yield* host.submit("cc2", asking);

    expect((yield* host.deliver(line())).status).toBe("done");
  }).pipe(Effect.provide(services))
);
