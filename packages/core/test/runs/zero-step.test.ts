import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const unused = () => Effect.die("a zero-step plan runs no step");

const services = Layer.mergeAll(
  NodeCrypto.layer,
  RunStore.memory,
  Layer.succeed(
    Thinker,
    Thinker.of({ decide: unused, elaborate: unused, think: unused })
  ),
  Layer.succeed(Judge, Judge.of({ choose: unused })),
  Layer.succeed(Mail, Mail.of({ seal: unused, send: unused })),
  Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
);

const zeroStep = {
  defaults: { agent: {} },
  envelope: {
    maxAgents: 0,
    maxDepth: 3,
    maxSteps: 20,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "Nothing to do",
  id: "no-op",
  machine: { id: "no-op", initial: "end", states: { end: { type: "final" } } },
};

it.effect(
  "a plan whose first state is final is done at once, and stays done when inspected",
  () =>
    Effect.gen(function* zero() {
      const host = yield* RunHost.make;

      const report = yield* host.submit("run", zeroStep);

      expect(report.status).toBe("done");
      expect(report.value).toBe("end");

      const inspected = yield* host.inspect("run");

      expect(inspected.status).toBe("done");
    }).pipe(Effect.provide(services))
);
