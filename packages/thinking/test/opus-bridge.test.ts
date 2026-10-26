import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, it } from "@effect/vitest";
import {
  DeclaredThinking,
  Thinker,
  thinkingLevels,
  validatePlan,
} from "@mischief/core";
import { Effect, Exit, Redacted, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  gatewayThinkerOptions,
  opusBridgeFrom,
  piThinker,
} from "../dist/index.js";
import type { GatewayConfig } from "../dist/index.js";

const configured = Schema.Literals(["absent", "empty", "set"]);

const valueOf = (state: typeof configured.Type, value: string) =>
  ({ absent: undefined, empty: "", set: value })[state];

const SSE = [
  {
    item: { content: [], id: "m", type: "message" },
    output_index: 0,
    type: "response.output_item.added",
  },
  { delta: "verdict", output_index: 0, type: "response.output_text.delta" },
  {
    item: {
      content: [{ text: "verdict", type: "output_text" }],
      id: "m",
      type: "message",
    },
    output_index: 0,
    type: "response.output_item.done",
  },
  {
    response: {
      id: "r",
      status: "completed",
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    },
    type: "response.completed",
  },
]
  .map((event) => `data: ${JSON.stringify(event)}\n\n`)
  .join("");

it.effect.prop(
  "Opus exists only with both bridge settings; submit refuses undeclared levels and accepted thinks reach only the Opus provider",
  {
    key: Arbitrary.schema(configured),
    level: Arbitrary.schema(Schema.Literals(thinkingLevels)),
    name: Arbitrary.schema(Schema.Literals(["opus", "claude-opus-5-5"])),
    url: Arbitrary.schema(configured),
  },
  ({ key, level, name, url }) =>
    Effect.gen(function* opusRouting() {
      const sent: { readonly body: string; readonly url: string }[] = [];

      // @effect-diagnostics-next-line asyncFunction:off -- A fake fetch implements the actual asynchronous provider boundary.
      const fetch: NonNullable<GatewayConfig["fetch"]> = async (
        input,
        init
      ) => {
        sent.push({
          body: Schema.decodeUnknownSync(Schema.String)(init?.body),
          url: new Request(input).url,
        });

        return await Promise.resolve(
          new Response(SSE, {
            headers: { "content-type": "text/event-stream" },
          })
        );
      };

      const bridge = opusBridgeFrom(
        valueOf(url, "https://opus.invalid/v1"),
        valueOf(key, "opus-key")
      );

      const options = gatewayThinkerOptions(
        () => Effect.succeed(new MemoryStorage()),
        {
          apiKey: Redacted.make("codex-key"),
          baseUrl: "https://codex.invalid/v1",
          fetch,
          opusBridge: bridge === undefined ? undefined : { ...bridge, fetch },
        }
      );

      const enabled = key === "set" && url === "set";
      const supported = enabled && level !== "off" && level !== "minimal";
      expect(options.modelRefs[name] !== undefined).toBe(enabled);

      const plan = {
        defaults: { agent: {} },
        envelope: {
          maxAgents: 1,
          maxDepth: 2,
          maxSteps: 5,
          maxThinking: "max",
          models: [name],
          names: [],
          thresholds: { judge: 0.8 },
        },
        id: "opus-review",
        machine: {
          id: "opus-review",
          initial: "review",
          states: {
            done: { type: "final" },
            review: {
              meta: {
                step: {
                  agent: { model: name, thinking: level },
                  kind: "think",
                  prompt: "fixed diff",
                },
              },
              on: { done: { target: "done" } },
            },
          },
        },
        version: 1,
      };

      const validated = yield* Effect.exit(
        validatePlan(plan).pipe(
          Effect.provideService(
            DeclaredThinking,
            options.declared ?? { fallback: "medium", models: {} }
          )
        )
      );

      expect(Exit.isSuccess(validated), JSON.stringify(validated)).toBe(
        supported
      );

      if (!supported) {
        expect(sent).toHaveLength(0);

        return;
      }

      const thought = yield* Thinker.use(({ think }) =>
        think({
          agent: { model: name, thinking: level },
          ceiling: "max",
          epoch: 0,
          key: "review",
          prompt: "fixed diff",
          runId: "opus-review",
          visit: 1,
        })
      ).pipe(Effect.provide(piThinker(options)));

      expect(thought.output).toBe("verdict");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toBe("https://opus.invalid/v1/responses");

      const body = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            model: Schema.String,
            reasoning: Schema.Struct({ effort: Schema.String }),
          })
        )
      )(sent[0]?.body ?? "");

      expect(body.model).toBe("claude-opus-5-5");
      expect(body.reasoning.effort).toBe(level);
    }),
  { arbitrary: { runs: 150 } }
);
