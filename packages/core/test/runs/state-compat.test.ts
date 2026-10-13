import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { RunStateSchema } from "../../src/runs/schema.js";

const RunStateJson = Schema.fromJsonString(RunStateSchema);

const OlderStateArbitrary = Arbitrary.map(
  Arbitrary.schema(RunStateSchema),
  (state) => ({
    ...state,
    awaiting: [],
    capped: null,
    checkpoint: null,
    held: [],
    replies: [],
  })
);

it.effect.prop(
  "a run file written before awaiting, capped, held and replies existed still reads",
  { state: OlderStateArbitrary },
  ({ state }) =>
    Effect.gen(function* property() {
      const {
        awaiting: _awaiting,
        capped: _capped,
        held: _held,
        replies: _replies,
        ...older
      } = yield* Schema.encodeEffect(RunStateSchema)(state);

      const read = yield* Schema.decodeEffect(RunStateJson)(
        JSON.stringify(older)
      );

      expect(read).toEqual(state);
    }),
  { arbitrary: { runs: 100 } }
);
