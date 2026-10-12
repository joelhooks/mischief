import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  directiveAddress,
  directiveKey,
  DirectiveKey,
  PendingDirectiveSchema,
  RunStateSchema,
} from "../../src/runs/schema.js";

const Address = Schema.Struct({
  index: Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 0 })),
  runId: Schema.Literals(["r", "run-1", "fleet-cleanup-7"]),
  step: Schema.Literals([
    "ask",
    "classify_check",
    "__envelope",
    "a1",
    "build.alpha.ask",
    "fan-out.b-2.ask_beta",
  ]),
  visit: Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 1 })),
});

it.effect.prop(
  "a directive key names exactly one run, step, visit and index, and reads back to them",
  {
    addresses: Arbitrary.schema(
      Schema.Array(Address).check(Schema.isMaxLength(24))
    ),
  },
  ({ addresses }) =>
    Effect.gen(function* property() {
      const byKey = new Map<string, string>();

      for (const address of addresses) {
        const key = directiveKey(address);

        yield* Schema.decodeUnknownEffect(DirectiveKey)(key);

        expect(directiveAddress(key)).toStrictEqual({ ...address });

        const seen = byKey.get(key);

        expect(seen ?? JSON.stringify(address)).toBe(JSON.stringify(address));

        byKey.set(key, JSON.stringify(address));
      }
    }),
  { arbitrary: { runs: 300 } }
);

it.effect.prop(
  "a pending directive survives the run file's JSON unchanged",
  { pending: Arbitrary.schema(PendingDirectiveSchema) },
  ({ pending }) =>
    Effect.gen(function* property() {
      const Json = Schema.fromJsonString(PendingDirectiveSchema);

      const text = yield* Schema.encodeEffect(Json)(pending);

      const read = yield* Schema.decodeEffect(Json)(text);

      expect(yield* Schema.encodeEffect(Json)(read)).toBe(text);
      expect(read.key).toBe(pending.key);
      expect(read.directive._tag).toBe(pending.directive._tag);
    }),
  { arbitrary: { runs: 200 } }
);

it.effect.prop(
  "a checkpoint written before directives existed reads with nothing pending",
  { state: Arbitrary.schema(RunStateSchema) },
  ({ state }) =>
    Effect.gen(function* property() {
      const encoded = yield* Schema.encodeEffect(RunStateSchema)({
        ...state,
        checkpoint:
          state.checkpoint === null
            ? null
            : { ...state.checkpoint, pending: [] },
      });

      const older =
        encoded.checkpoint === null
          ? encoded
          : {
              ...encoded,
              checkpoint: Object.fromEntries(
                Object.entries(encoded.checkpoint).filter(
                  ([field]) => field !== "pending"
                )
              ),
            };

      const read = yield* Schema.decodeUnknownEffect(RunStateSchema)(
        structuredClone(older)
      );

      expect(read.checkpoint?.pending ?? []).toStrictEqual([]);
      expect(read.checkpoint === null).toBe(state.checkpoint === null);
    }),
  { arbitrary: { runs: 100 } }
);
