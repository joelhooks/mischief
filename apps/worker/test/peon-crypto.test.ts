import { expect, it } from "@effect/vitest";
import { PEON_CATALOG_SOURCE } from "@mischief/core";
import { Effect } from "effect";

import catalog from "../../../packages/core/src/peons/catalog.v1.json" with { type: "json" };
import { freshPeonId, hashPeonText } from "../src/peon-crypto.js";

it.effect("the formatted catalog reconstructs the pinned source SHA", () =>
  Effect.gen(function* source() {
    const hash = yield* hashPeonText(`${JSON.stringify(catalog, null, 2)}\n`);

    expect(hash).toBe(PEON_CATALOG_SOURCE.sha256);
  })
);

it.effect(
  "new instance ids fit the box grammar and request phases do not collide",
  () =>
    Effect.gen(function* identity() {
      const first = yield* freshPeonId;
      const second = yield* freshPeonId;

      const main = yield* hashPeonText(
        JSON.stringify(["worker-a", "prompt", "x/resume", "main"])
      );

      const resume = yield* hashPeonText(
        JSON.stringify(["worker-a", "prompt", "x", "resume"])
      );

      expect(first).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/u);
      expect(first).not.toBe(second);
      expect(main).toHaveLength(64);
      expect(main).not.toBe(resume);
    })
);
