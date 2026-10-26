import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { repoRoot, runOxlint } from "./oxlint-fixture.js";

const lint = (source: string) =>
  runOxlint({
    config: {
      jsPlugins: [
        {
          name: "xstate-effect",
          specifier: `${repoRoot}/scripts/oxlint-plugin-xstate-effect.ts`,
        },
      ],
      rules: { "xstate-effect/no-inline-effect": "error" },
    },
    prefix: "mischief-effect-logic-",
    source,
  });

it.effect.each([
  "createEffectLogic",
  "createEffectStreamLogic",
  "createEffectEventStreamLogic",
  "fromEffect",
  "fromEffectStream",
  "fromEffectEventStream",
])(
  "%s cannot hide an inline actor from the requirements collector",
  (constructor) =>
    Effect.gen(function* inline() {
      const result = yield* lint(
        `export const transition = (args, enq) => { enq.spawn(${constructor}(task)); };`
      );

      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        "Inline Effect logic passed to enq.spawn"
      );
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("declared Effect actors keep their requirements visible", () =>
  Effect.gen(function* declared() {
    const result = yield* lint(
      "export const transition = (args, enq) => { enq.spawn(args.actors.task); };"
    );

    expect(result.status).toBe(0);
  }).pipe(Effect.provide(NodeServices.layer))
);
