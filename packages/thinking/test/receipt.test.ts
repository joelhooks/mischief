import type { AssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "@effect/vitest";
import { thinkingLevels } from "@mischief/core";
import type { AgentConfig } from "@mischief/core";
import { Schema } from "effect";

import { receiptOf, requestedOf } from "../src/receipt.js";

const Level = Schema.Literals(thinkingLevels);

const World = Schema.Struct({
  ceiling: Level,
  defaultLevel: Level,
  planLevel: Schema.optionalKey(Level),
  planModel: Schema.optionalKey(Schema.Literals(["gpt-6.1-sol", "sol"])),
  servedLevel: Schema.optionalKey(Level),
  servedModel: Schema.optionalKey(
    Schema.Literals(["gpt-6.1-sol", "gpt-6.1-sol-2026-10-01", "gpt-6-luna"])
  ),
  tokens: Schema.Int.check(Schema.isBetween({ maximum: 9999, minimum: 0 })),
});

const MODEL_ID = "gpt-6.1-sol";

const bare = (tokens: number): AssistantMessage => ({
  api: "openai-responses",
  content: [{ text: "ok", type: "text" }],
  model: MODEL_ID,
  provider: "cliproxy-codex",
  role: "assistant",
  stopReason: "stop",
  timestamp: 0,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: tokens,
    output: 0,
    totalTokens: tokens,
  },
});

const answer = (world: typeof World.Type): AssistantMessage => {
  const base = bare(world.tokens);

  const served =
    world.servedModel === undefined
      ? base
      : { ...base, responseModel: world.servedModel };

  return world.servedLevel === undefined
    ? served
    : { ...served, providerThinkingLevel: world.servedLevel };
};

const agentOf = (world: typeof World.Type): AgentConfig => {
  const named = world.planModel === undefined ? {} : { model: world.planModel };

  return world.planLevel === undefined
    ? named
    : { ...named, thinking: world.planLevel };
};

it.prop(
  "a receipt names who chose the model, and is unmatched exactly when the server answered with another model or effort",
  { world: World },
  ({ world }) => {
    const requested = requestedOf(
      agentOf(world),
      { model: MODEL_ID, thinking: world.defaultLevel },
      world.ceiling
    );

    const receipt = receiptOf(requested, MODEL_ID, [answer(world)]);

    expect(receipt.requested.from).toBe(
      world.planModel === undefined ? "default" : "plan"
    );

    const capped =
      thinkingLevels.indexOf(world.defaultLevel) >
      thinkingLevels.indexOf(world.ceiling);

    const expectedFrom = capped ? "envelope" : "default";

    expect(receipt.requested).toMatchObject(
      world.planLevel === undefined
        ? {
            thinking: capped ? world.ceiling : world.defaultLevel,
            thinkingFrom: expectedFrom,
          }
        : { thinking: world.planLevel, thinkingFrom: "plan" }
    );

    const otherModel = world.servedModel === "gpt-6-luna";

    const otherLevel =
      world.servedLevel !== undefined &&
      world.servedLevel !== receipt.requested.thinking;

    expect(receipt.matched).toBe(!otherModel && !otherLevel);
    expect(receipt.effective.model).toBe(world.servedModel ?? MODEL_ID);
    expect(receipt.tokens.total).toBe(world.tokens);
  }
);

it("a turn with no assistant answer is recorded as unmatched, never as the requested model", () => {
  const receipt = receiptOf(
    requestedOf({}, { model: MODEL_ID, thinking: "medium" }, "high"),
    MODEL_ID,
    []
  );

  expect(receipt.matched).toBe(false);
  expect(receipt.effective).toStrictEqual({ model: null, thinking: null });
});
