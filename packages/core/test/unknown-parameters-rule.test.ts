import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { repoRoot, runOxlint } from "./oxlint-fixture.js";

const plugin = `${repoRoot}/tools/oxlint/anti-slop/index.ts`;

const lint = (source: string) =>
  runOxlint({
    config: {
      jsPlugins: [{ name: "anti-slop", specifier: plugin }],
      rules: { "anti-slop/no-unknown-parameters": "error" },
    },
    prefix: "rat-stack-unknown-",
    source,
  });

describe("anti-slop/no-unknown-parameters", () => {
  it.effect("allows the reason a promise rejection handler receives", () =>
    Effect.gen(function* allows() {
      const result = yield* lint(
        [
          "export const a = (p: Promise<number>) => p.then(() => null, (error: unknown) => error);",
          "export const b = (p: Promise<number>) => p.catch((error: unknown) => error);",
          "export const c = (p: Promise<number>) => p.catch(function reject(error: unknown) { return error; });",
          "",
        ].join("\n")
      );

      expect(result.output).not.toContain("no-unknown-parameters");
      expect(result.status).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("still rejects unknown parameters outside rejection position", () =>
    Effect.gen(function* rejects() {
      const result = yield* lint(
        [
          "export const fulfilled = (p: Promise<unknown>) => p.then((value: unknown) => value);",
          "export const second = (p: Promise<number>) => p.then(() => null, (error: unknown, extra: unknown) => [error, extra]);",
          'export const computed = (p: Promise<number>, then: "then") => p[then](() => null, (reason: unknown) => reason);',
          "export const plain = (input: unknown) => input;",
          "",
        ].join("\n")
      );

      expect(result.output).toContain(
        "Parameter `value` leaves input unparsed"
      );
      expect(result.output).toContain(
        "Parameter `extra` leaves input unparsed"
      );
      expect(result.output).toContain(
        "Parameter `input` leaves input unparsed"
      );
      expect(result.output).toContain(
        "Parameter `reason` leaves input unparsed"
      );
      expect(result.output).not.toContain(
        "Parameter `error` leaves input unparsed"
      );
    }).pipe(Effect.provide(NodeServices.layer))
  );
});
