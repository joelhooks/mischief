import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, it } from "@effect/vitest";
import { Thinker } from "@mischief/core";
import { Effect, Redacted } from "effect";

import { gatewayThinkerOptions, piThinker } from "../dist/index.js";

it.effect(
  "an unconfigured workspace route never falls back to the ordinary model gateway",
  () =>
    Effect.gen(function* missingRoute() {
      const options = gatewayThinkerOptions(
        () => Effect.succeed(new MemoryStorage()),
        {
          apiKey: Redacted.make("gateway-key"),
          baseUrl: "https://must-not-call.invalid/v1",
        }
      );

      const reason = yield* Thinker.use(({ think }) =>
        think({
          agent: {
            model: "sol",
            tools: ["read", "grep", "find", "ls", "bash"],
            workspace: { repo: "example/project", sha: "a".repeat(40) },
          },
          ceiling: "high",
          epoch: 0,
          key: "read",
          prompt: "Read code",
          runId: "workspace",
          visit: 1,
        })
      ).pipe(
        Effect.as("unexpected success"),
        Effect.catchTag("StepFailed", (error) => Effect.succeed(error.reason)),
        Effect.provide(piThinker(options))
      );

      expect(reason).toContain("agent.workspace");
      expect(reason).toContain("MISCHIEF_WORKSPACE=on");
      expect(reason).toContain("MISCHIEF_WORKSPACE_BRIDGE_KEY");
    })
);
