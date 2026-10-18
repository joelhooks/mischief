import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Crypto, Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { fingerprintOf } from "../../src/runs/fingerprint.js";
import { RunStore } from "../../src/runs/run-store.js";
import { Judge } from "../../src/steps/judge.js";
import { Mail } from "../../src/steps/mail.js";
import { Operator } from "../../src/steps/operator.js";
import { Thinker } from "../../src/steps/thinker.js";
import { InlineRunHost as RunHost } from "./inline-host.js";

const PromptsSchema = Schema.Array(Schema.Literals(["a", "b", "c"])).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(5)
);

const planOf = (prompts: readonly string[]) => ({
  defaults: { agent: {} },
  envelope: {
    maxAgents: 10,
    maxDepth: 3,
    maxSteps: 100,
    maxThinking: "low",
    models: ["sol"],
    names: [],
    thresholds: { judge: 0.8 },
  },
  goal: "a line of thoughts",
  id: "line",
  machine: {
    id: "line",
    initial: "s0",
    states: {
      end: { type: "final" },
      ...Object.fromEntries(
        prompts.map((prompt, index) => [
          `s${index}`,
          {
            meta: { step: { kind: "think", prompt } },
            on: {
              done: {
                target: index === prompts.length - 1 ? "end" : `s${index + 1}`,
              },
            },
          },
        ])
      ),
    },
  },
});

const services = Layer.mergeAll(
  Layer.succeed(
    Thinker,
    Thinker.of({
      decide: () => Effect.die("unused"),
      elaborate: () => Effect.die("unused"),
      think: () => Effect.succeed({ output: "thought", tokens: 1 }),
    })
  ),
  Layer.succeed(Judge, Judge.of({ choose: () => Effect.die("unused") })),
  Layer.succeed(
    Mail,
    Mail.of({
      seal: () => Effect.die("unused"),
      send: () => Effect.die("unused"),
    })
  ),
  Layer.succeed(Operator, Operator.of({ notify: () => Effect.void }))
);

const writes: string[] = [];

const recorded = Layer.effect(
  RunStore,
  Effect.gen(function* recording() {
    const store = yield* RunStore;

    return RunStore.of({
      ...store,
      writeFingerprint: (runId, key, fingerprint) =>
        Effect.sync(() => writes.push(`fingerprint ${runId} ${key}`)).pipe(
          Effect.andThen(store.writeFingerprint(runId, key, fingerprint))
        ),
      writeJournal: (runId, key, entry) =>
        Effect.sync(() => writes.push(`journal ${runId} ${key}`)).pipe(
          Effect.andThen(store.writeJournal(runId, key, entry))
        ),
    });
  })
).pipe(Layer.provide(RunStore.memory));

it.effect.prop(
  "each step's fingerprint is written before its result, and changes exactly when the step does",
  {
    edit: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 0 }))
    ),
    prompts: Arbitrary.schema(PromptsSchema),
  },
  ({ edit, prompts }) =>
    Effect.gen(function* property() {
      const at = edit % prompts.length;

      const edited = prompts.map((prompt, index) =>
        index === at ? `${prompt} again` : prompt
      );

      writes.length = 0;
      const host = yield* RunHost.make.pipe(Effect.provide(NodeCrypto.layer));
      const store = yield* RunStore;

      expect((yield* host.submit("one", planOf(prompts))).status).toBe("done");
      expect((yield* host.submit("two", planOf(edited))).status).toBe("done");

      const one = yield* store.readFingerprints("one");
      const two = yield* store.readFingerprints("two");
      const journal = yield* store.readJournal("one");

      expect([...one.keys()].toSorted()).toEqual(
        [...journal.keys()].filter((key) => key.startsWith("logic:")).toSorted()
      );
      expect([...two.keys()].toSorted()).toEqual([...one.keys()].toSorted());
      expect(one.size).toBe(prompts.length);

      for (const key of one.keys()) {
        expect(writes.indexOf(`fingerprint one ${key}`)).toBeLessThan(
          writes.indexOf(`journal one ${key}`)
        );
        expect(one.get(key)).toMatch(/^[0-9a-f]{64}$/u);
        expect({ key, same: one.get(key) === two.get(key) }).toEqual({
          key,
          same: !key.includes(`.s${at}#`),
        });
      }
    }).pipe(Effect.provide(Layer.merge(services, recorded))),
  { arbitrary: { runs: 60 } }
);

const byKey = (
  [left]: readonly [string, unknown],
  [right]: readonly [string, unknown]
) => (left < right ? -1 : 1);

const Leaf = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
]);

const ValueSchema = Schema.Record(
  Schema.Literals(["a", "b", "c", "d"]),
  Schema.Union([Leaf, Schema.Array(Leaf)])
);

it.effect.prop(
  "a fingerprint ignores key order at any depth, and tells different values apart",
  {
    left: Arbitrary.schema(ValueSchema),
    right: Arbitrary.schema(ValueSchema),
  },
  ({ left, right }) =>
    Effect.gen(function* property() {
      const reordered = Object.fromEntries(Object.entries(left).toReversed());
      const crypto = yield* Crypto.Crypto;
      const print = yield* fingerprintOf(crypto, left);

      expect(yield* fingerprintOf(crypto, reordered)).toBe(print);
      expect(yield* fingerprintOf(crypto, { nested: reordered })).toBe(
        yield* fingerprintOf(crypto, { nested: left })
      );
      expect(yield* fingerprintOf(crypto, [reordered, left])).toBe(
        yield* fingerprintOf(crypto, [left, left])
      );
      expect((yield* fingerprintOf(crypto, right)) === print).toBe(
        JSON.stringify(Object.entries(right).toSorted(byKey)) ===
          JSON.stringify(Object.entries(left).toSorted(byKey))
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
  { arbitrary: { runs: 200 } }
);
