// @effect-diagnostics nodeBuiltinImport:off -- A fresh Node process with --expose-gc measures retained heap without the Vitest runtime or other tests sharing its heap.
import { spawn } from "node:child_process";
import path from "node:path";

import { expect, it } from "@effect/vitest";
import { ThinkReceiptSchema } from "@mischief/core";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

const StreamSchema = Schema.Struct({
  chunks: Schema.Int.check(Schema.isBetween({ maximum: 1200, minimum: 500 })),
  width: Schema.Int.check(Schema.isBetween({ maximum: 96, minimum: 32 })),
});

const ResultSchema = Schema.fromJsonString(
  Schema.Struct({
    exact: Schema.Boolean,
    growth: Schema.Finite,
    heaps: Schema.Array(Schema.Finite),
    receipt: ThinkReceiptSchema,
    tokens: Schema.Int,
  })
);

const measure = (stream: typeof StreamSchema.Type, held: boolean) =>
  Effect.callback<string>((resume) => {
    const child = spawn(
      process.execPath,
      [
        "--expose-gc",
        path.join(import.meta.dirname, "stream-heap-child.ts"),
        JSON.stringify({ ...stream, held, width: stream.width * 4 }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let output = "";
    let errors = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.on("error", (error) => {
      resume(Effect.die(error));
    });
    child.on("close", (code) => {
      const result = output
        .split("\n")
        .find((line) => line.startsWith("RESULT "));

      resume(
        code === 0 && result !== undefined
          ? Effect.succeed(result.slice("RESULT ".length))
          : Effect.die(
              new Error(`heap child exited ${code}: ${errors}\n${output}`)
            )
      );
    });

    return Effect.sync(() => {
      child.kill();
    });
  });

it.effect.prop(
  "releasing the first-token view preserves streamed output and receipts with less than 8 MiB extra sampled heap regardless of output length",
  { stream: Arbitrary.schema(StreamSchema) },
  ({ stream }) =>
    Effect.gen(function* property() {
      const result = yield* Schema.decodeEffect(ResultSchema)(
        yield* measure(stream, false)
      );

      const held = yield* Schema.decodeEffect(ResultSchema)(
        yield* measure(stream, true)
      );

      const tokens = {
        cacheRead: 0,
        input: 85_000,
        output: stream.chunks * stream.width,
        total: 85_000 + stream.chunks * stream.width,
      };

      expect(held.exact).toBe(true);
      expect(held.tokens).toBe(result.tokens);
      expect({ ...held.receipt, latencyMs: null }).toEqual({
        ...result.receipt,
        latencyMs: null,
      });
      expect(result.exact).toBe(true);
      expect(result.tokens).toBe(tokens.total);
      expect(result.receipt).toMatchObject({
        effective: { model: "gpt-6-luna", thinking: "max" },
        matched: true,
        requested: {
          from: "plan",
          model: "luna",
          thinking: "max",
          thinkingFrom: "plan",
        },
        tokens,
      });
      expect(result.heaps.length).toBeGreaterThan(5);
      expect(result.growth).toBeLessThan(8 * 1024 * 1024);
    }),
  { arbitrary: { runs: 6 }, timeout: 120_000 }
);
