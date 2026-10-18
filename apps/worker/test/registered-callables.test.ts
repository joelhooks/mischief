import { expect, it } from "@effect/vitest";
import { callable } from "@mischief/core";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { registeredCallables } from "../src/registered-callables.js";

const echo = callable({
  input: Schema.String,
  output: Schema.String,
  run: Effect.succeed,
});

it.prop(
  "duplicate registration is refused before a Map can silently discard an entry",
  {
    suffix: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 999_999, minimum: 0 }))
    ),
  },
  ({ suffix }) => {
    const name = `echo-${suffix}`;

    expect(() =>
      registeredCallables([
        [name, echo],
        [name, echo],
      ])
    ).toThrow(`Cannot register duplicate call capability "${name}"`);
  }
);

it.prop(
  "registration uses the same capability-name rule as plans and snapshots the caller-owned entries",
  { name: Arbitrary.schema(Schema.String) },
  ({ name }) => {
    const entries = new Map([[name, echo]]);

    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name)) {
      expect(() => registeredCallables(entries)).toThrow(
        "names must match ^[a-z][a-z0-9-]{0,63}$"
      );

      return;
    }

    const registry = registeredCallables(entries);

    entries.clear();
    expect(registry.get(name)).toBe(echo);
  }
);
