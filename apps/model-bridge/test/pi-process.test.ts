import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Effect,
  FileSystem,
  Layer,
  Logger,
  Path,
  Redacted,
  Schema,
} from "effect";

import { PiProcess } from "../src/pi-process.js";
import { request } from "./fixtures.js";

const ChildReceipt = Schema.Struct({
  agentDir: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  debug: Schema.String,
  files: Schema.Array(Schema.String),
  inheritedOwner: Schema.NullOr(Schema.String),
  input: Schema.String,
  maxTokens: Schema.String,
  ratking: Schema.String,
  settings: Schema.Struct({
    compaction: Schema.Struct({ enabled: Schema.Boolean }),
    retry: Schema.Struct({
      enabled: Schema.Boolean,
      maxRetries: Schema.Int,
      provider: Schema.Struct({ maxRetries: Schema.Int }),
    }),
  }),
});

it.effect(
  "real child calls get fresh empty directories, no identity or tools, disabled retries, stdin prompts, and metadata-only logs",
  () =>
    Effect.gen(function* processSeam() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logged: string[] = [];

      const config = {
        claude: "/unused/claude",
        cliproxyKey: Redacted.make("private-cliproxy-key"),
        cliproxyUrl: "https://cliproxy.invalid",
        extension: "/only/claude-bridge.ts",
        pi: path.join(import.meta.dirname, "fake-pi.ts"),
      };

      const receipts = yield* Effect.gen(function* childCalls() {
        const pi = yield* PiProcess;

        return yield* Effect.forEach([16, 128_000], (max_output_tokens) =>
          pi
            .run({ ...request, max_output_tokens })
            .pipe(
              Effect.flatMap(({ text }) =>
                Schema.decodeEffect(Schema.fromJsonString(ChildReceipt))(text)
              )
            )
        );
      }).pipe(
        Effect.provide(
          Layer.merge(
            PiProcess.layer(config),
            Logger.layer([
              Logger.make(({ message }) => {
                logged.push(JSON.stringify(message));
              }),
            ])
          )
        )
      );

      expect(new Set(receipts.map(({ cwd }) => cwd)).size).toBe(2);
      expect(new Set(receipts.map(({ agentDir }) => agentDir)).size).toBe(1);

      for (const [index, receipt] of receipts.entries()) {
        expect(receipt.files).toEqual([]);
        expect(receipt.ratking).toBe("off");
        expect(receipt.inheritedOwner).toBeNull();
        expect(receipt.debug).toBe("0");
        expect(receipt.maxTokens).toBe(index === 0 ? "16" : "128000");
        expect(receipt.args).toContain("--no-tools");
        expect(receipt.args).toContain("--no-extensions");
        expect(receipt.args).toContain("--no-session");
        expect(receipt.args).toContain("/only/claude-bridge.ts");
        expect(receipt.args.join(" ")).not.toContain("private review prompt");
        expect(receipt.input).toContain("private review prompt");
        expect(receipt.settings).toEqual({
          compaction: { enabled: false },
          retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
        });
        expect(yield* fs.exists(receipt.cwd)).toBe(false);
        expect(yield* fs.exists(receipt.agentDir)).toBe(false);
      }

      expect(logged).toHaveLength(2);
      expect(logged.join("\n")).not.toContain("private review prompt");
      expect(logged.join("\n")).not.toContain("private-cliproxy-key");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
