// @effect-diagnostics asyncFunction:off -- the fake fetch stands in for the model proxy, and fetch is async.
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, it } from "@effect/vitest";
import { Thinker, thinkingLevels } from "@mischief/core";
import { Effect, Redacted, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  GATEWAY_MODELS,
  gatewayThinkerOptions,
  piThinker,
  promptCacheKeyOf,
} from "../dist/index.js";
import type { GatewayConfig } from "../dist/index.js";

const SSE = [
  { response: { id: "resp-1" }, type: "response.created" },
  {
    item: { content: [], id: "msg-1", type: "message" },
    output_index: 0,
    type: "response.output_item.added",
  },
  { delta: "ok", output_index: 0, type: "response.output_text.delta" },
  {
    item: {
      content: [{ text: "ok", type: "output_text" }],
      id: "msg-1",
      type: "message",
    },
    output_index: 0,
    type: "response.output_item.done",
  },
  {
    response: {
      id: "resp-1",
      status: "completed",
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    },
    type: "response.completed",
  },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

const BodySchema = Schema.Struct({
  model: Schema.String,
  prompt_cache_key: Schema.optionalKey(Schema.String),
  reasoning: Schema.optionalKey(Schema.Struct({ effort: Schema.String })),
});

const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(BodySchema));

interface Sent extends Readonly<typeof BodySchema.Type> {
  readonly session: string | null;
}

const proxy = () => {
  const bodies: Sent[] = [];

  const fetch: NonNullable<GatewayConfig["fetch"]> = async (_input, init) => {
    bodies.push({
      ...decodeBody(init?.body),
      session: new Headers(init?.headers).get("session_id"),
    });

    return await Promise.resolve(
      new Response(SSE, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      })
    );
  };

  return { bodies, fetch };
};

const ModelName = Schema.Literals([
  "gpt-6-luna",
  "gpt-6.1-sol",
  "luna",
  "sol",
] satisfies (keyof typeof GATEWAY_MODELS)[]);

type GatewayName = typeof ModelName.Type;

type Level = (typeof thinkingLevels)[number];

const LUNA_EFFORTS: Readonly<Record<Level, string>> = {
  high: "high",
  low: "low",
  max: "max",
  medium: "medium",
  minimal: "minimal",
  off: "none",
  xhigh: "xhigh",
};

const SOL_EFFORTS: Readonly<Record<Level, string>> = {
  ...LUNA_EFFORTS,
  max: "high",
  xhigh: "high",
};

const EFFORTS = {
  "gpt-6-luna": LUNA_EFFORTS,
  "gpt-6.1-sol": SOL_EFFORTS,
} satisfies Readonly<
  Record<(typeof GATEWAY_MODELS)[GatewayName], Readonly<Record<Level, string>>>
>;

const ThinkSchema = Schema.Struct({
  level: Schema.Literals(thinkingLevels),
  model: ModelName,
  run: Schema.Literals([
    "run-a",
    "run-b",
    "a-very-long-run-id-that-fills-most-of-the-sixty-four-char-limit",
  ]),
});

const thinkAll = (
  thinks: readonly (typeof ThinkSchema.Type)[],
  fetch: ReturnType<typeof proxy>["fetch"]
) =>
  Effect.gen(function* all() {
    const thinker = yield* Thinker;

    return yield* Effect.forEach(
      thinks,
      ({ level, model, run }, index) =>
        thinker.think({
          agent: { model, thinking: level },
          ceiling: "max",
          epoch: 0,
          key: `step${index}`,
          prompt: `secret doc text ${index}`,
          runId: run,
          visit: 1,
        }),
      { concurrency: "unbounded" }
    );
  }).pipe(
    Effect.provide(
      piThinker(
        gatewayThinkerOptions(() => Effect.succeed(new MemoryStorage()), {
          apiKey: Redacted.make("test-key"),
          baseUrl: "https://model-proxy.test/v1",
          fetch,
        })
      )
    )
  );

const modelIdOf = (name: GatewayName) => GATEWAY_MODELS[name];

it.effect.prop(
  "every gateway think sends its model, the effort its level maps to, and one prompt cache key per run",
  {
    thinks: Arbitrary.schema(
      Schema.Array(ThinkSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(6)
      )
    ),
  },
  ({ thinks }) =>
    Effect.gen(function* property() {
      const { bodies, fetch } = proxy();

      yield* thinkAll(thinks, fetch);

      expect(bodies).toHaveLength(thinks.length);

      const sent = (think: (typeof thinks)[number]) =>
        bodies.find(
          (body) =>
            body.model === modelIdOf(think.model) &&
            body.prompt_cache_key === promptCacheKeyOf(think.run) &&
            body.reasoning?.effort ===
              EFFORTS[modelIdOf(think.model)][think.level]
        );

      for (const think of thinks) {
        expect(sent(think)).toBeDefined();
      }

      const keys = new Set(bodies.map((body) => body.prompt_cache_key));
      const runs = new Set(thinks.map(({ run }) => run));

      expect(keys.size).toBe(runs.size);

      for (const body of bodies) {
        expect(body.session).toBe(body.prompt_cache_key);
      }

      for (const key of keys) {
        expect(key?.length).toBeLessThanOrEqual(64);
        expect(key).toMatch(/^mischief-/u);
        expect(key).not.toContain("secret");
      }
    }),
  { arbitrary: { runs: 25 }, timeout: 60_000 }
);

it.effect("a luna think at max sends effort max and records luna/max", () =>
  Effect.gen(function* lunaMax() {
    const { bodies, fetch } = proxy();

    const [thought] = yield* thinkAll(
      [{ level: "max", model: "luna", run: "run-a" }],
      fetch
    );

    expect(bodies).toStrictEqual([
      {
        model: "gpt-6-luna",
        prompt_cache_key: "mischief-run-a",
        reasoning: { effort: "max" },
        session: "mischief-run-a",
      },
    ]);
    expect(thought?.receipt).toMatchObject({
      requested: { model: "luna", thinking: "max", thinkingFrom: "plan" },
    });
  })
);
