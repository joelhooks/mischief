// @effect-diagnostics nodeBuiltinImport:off -- This seam test runs the real oxlint binary against disposable source fixtures.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

const lint = (source: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), "mischief-effect-logic-"));
  const config = path.join(directory, "oxlint.json");
  const file = path.join(directory, "fixture.ts");
  writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: [
        {
          name: "xstate-effect",
          specifier: path.join(root, "scripts/oxlint-plugin-xstate-effect.ts"),
        },
      ],
      rules: { "xstate-effect/no-inline-effect": "error" },
    })
  );
  writeFileSync(file, source);

  try {
    const result = spawnSync(
      path.join(root, "node_modules/.bin/oxlint"),
      ["--config", config, "--no-ignore", file],
      { cwd: root, encoding: "utf-8" }
    );

    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status,
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

it.each([
  "createEffectLogic",
  "createEffectStreamLogic",
  "createEffectEventStreamLogic",
  "fromEffect",
  "fromEffectStream",
  "fromEffectEventStream",
])(
  "%s cannot hide an inline actor from the requirements collector",
  (constructor) => {
    const result = lint(
      `export const transition = (args, enq) => { enq.spawn(${constructor}(task)); };`
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Inline Effect logic passed to enq.spawn");
  }
);

it("declared Effect actors keep their requirements visible", () => {
  expect(
    lint(
      "export const transition = (args, enq) => { enq.spawn(args.actors.task); };"
    ).status
  ).toBe(0);
});
