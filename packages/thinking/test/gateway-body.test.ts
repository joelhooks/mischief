// @effect-diagnostics asyncFunction:off -- the fake fetch stands in for the model proxy, and fetch is async.
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, it } from "@effect/vitest";
import { Thinker, thinkingLevels } from "@mischief/core";
import { Effect, Option, Redacted, Schema } from "effect";
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
  "every gateway think sends its model, the effort its level maps to, and one prompt cache key per run, and its receipt claims only the effort sent",
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

      const thoughts = yield* thinkAll(thinks, fetch);

      expect(bodies).toHaveLength(thinks.length);

      for (const [index, think] of thinks.entries()) {
        const receipt = thoughts[index]?.receipt;

        const claimed =
          receipt?.effective.thinking ?? receipt?.requested.thinking;

        expect(
          Object.entries(LUNA_EFFORTS).find(([level]) => level === claimed)?.[1]
        ).toBe(EFFORTS[modelIdOf(think.model)][think.level]);
      }

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

it.effect.prop(
  "workspace thinks send checkout and shell tools only to the authenticated workspace endpoint; ordinary thinks keep their route, and busy bridges park",
  {
    model: Arbitrary.schema(Schema.Literals(["sol", "opus"])),
    status: Arbitrary.schema(Schema.Literals([200, 400, 503])),
    tool: Arbitrary.schema(
      Schema.Literals(["read", "grep", "find", "ls", "bash"])
    ),
  },
  ({ tool, model, status }) =>
    Effect.gen(function* routing() {
      const workspace = { repo: "example/project", sha: "a".repeat(40) };

      const tools = [
        tool,
        ...["read", "grep", "find", "ls", "bash"].filter(
          (name) => name !== tool
        ),
      ];

      const sent: {
        readonly url: string;
        readonly auth: string | null;
        readonly body: string;
      }[] = [];

      const fetch: NonNullable<GatewayConfig["fetch"]> = async (
        input,
        init
      ) => {
        const request = new Request(input, init);
        sent.push({
          auth: request.headers.get("authorization"),
          body: Schema.decodeUnknownSync(Schema.String)(init?.body),
          url: request.url,
        });
        const code = request.url.includes("workspace.invalid") ? status : 200;

        return await Promise.resolve(
          new Response(
            code === 200
              ? SSE
              : JSON.stringify({
                  error: {
                    message:
                      "agent.workspace: bridge unavailable; retry when ready",
                  },
                }),
            {
              headers: {
                "content-type":
                  code === 200 ? "text/event-stream" : "application/json",
              },
              status: code,
            }
          )
        );
      };

      const options = gatewayThinkerOptions(
        () => Effect.succeed(new MemoryStorage()),
        {
          apiKey: Redacted.make("gateway-key"),
          baseUrl: "https://gateway.invalid/v1",
          fetch,
          opusBridge: {
            apiKey: Redacted.make("opus-key"),
            baseUrl: "https://opus.invalid/v1",
            fetch,
          },
          workspaceBridge: {
            apiKey: Redacted.make("workspace-key"),
            baseUrl: "https://workspace.invalid/v1/responses",
            fetch,
          },
        }
      );

      yield* Effect.gen(function* sequence() {
        const thinker = yield* Thinker;

        const call = {
          ceiling: "high",
          epoch: 0,
          key: "read",
          prompt: "Read code",
          runId: "workspace",
          visit: 1,
        } as const;

        const outcome = yield* thinker
          .think({
            ...call,
            agent: { model, thinking: "low", tools, workspace },
          })
          .pipe(
            Effect.map(({ output }) => output),
            Effect.catchTags({
              ProviderUnavailable: (error) =>
                Effect.succeed(`parked:${error.status}`),
              StepFailed: () => Effect.succeed("refused"),
            })
          );

        expect(outcome).toBe(
          { 200: "ok", 400: "refused", 503: "parked:503" }[status]
        );
        expect(sent).toHaveLength(1);
        expect(sent[0]?.url).toBe("https://workspace.invalid/v1/responses");
        expect(sent[0]?.auth).toBe("Bearer workspace-key");

        const body = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              model: Schema.String,
              tools: Schema.Array(Schema.String),
              workspace: Schema.Struct({
                repo: Schema.String,
                sha: Schema.String,
              }),
            })
          )
        )(sent[0]?.body);

        expect(body.workspace).toEqual(workspace);
        expect(body.tools).toEqual(tools);
        expect(body.model).toBe(
          model === "opus" ? "claude-opus-5-5" : "gpt-6.1-sol"
        );

        const ordinary = yield* thinker.think({
          ...call,
          agent: { model, thinking: "low" },
          key: "plain",
        });

        expect(ordinary.output).toBe("ok");
        expect(sent).toHaveLength(2);
        expect(sent[1]?.url).toBe(
          model === "opus"
            ? "https://opus.invalid/v1/responses"
            : "https://gateway.invalid/v1/responses"
        );
        expect(sent[1]?.body).not.toContain('"workspace"');
      }).pipe(Effect.provide(piThinker(options)));
    }),
  { arbitrary: { runs: 30 } }
);

it.effect.prop(
  "a workspace source model that disappears or cannot be routed fails with its model name without calling any provider",
  {
    missingSource: Arbitrary.schema(Schema.Boolean),
    model: Arbitrary.schema(Schema.Literals(["sol", "gpt-6.1-sol"])),
  },
  ({ missingSource, model }) =>
    Effect.gen(function* unroutableWorkspace() {
      const sent: string[] = [];

      const fetch: NonNullable<GatewayConfig["fetch"]> = async (input) => {
        sent.push(new Request(input).url);

        return await Promise.resolve(
          new Response(SSE, {
            headers: { "content-type": "text/event-stream" },
          })
        );
      };

      const options = gatewayThinkerOptions(
        () => Effect.succeed(new MemoryStorage()),
        {
          apiKey: Redacted.make("gateway-key"),
          baseUrl: "https://gateway.invalid/v1",
          fetch,
          workspaceBridge: {
            apiKey: Redacted.make("workspace-key"),
            baseUrl: "https://workspace.invalid/v1/responses",
            fetch,
          },
        }
      );

      const agent = {
        model,
        tools: ["read", "grep", "find", "ls", "bash"],
        workspace: { repo: "example/project", sha: "a".repeat(40) },
      };

      const missingRef = {
        modelId: "missing-source-model",
        provider: "cliproxy-codex",
      };

      if (missingSource) {
        expect(options.workspaceModelRef?.(agent, missingRef)).toEqual(
          Option.none()
        );
      }

      const configured = missingSource
        ? {
            ...options,
            modelRefs: { ...options.modelRefs, [model]: missingRef },
          }
        : { ...options, workspaceModelRef: () => Option.none() };

      const reason = yield* Thinker.use(({ think }) =>
        think({
          agent,
          ceiling: "high",
          epoch: 0,
          key: "read",
          prompt: "Read code",
          runId: "missing-source",
          visit: 1,
        })
      ).pipe(
        Effect.as("unexpected success"),
        Effect.catchTag("StepFailed", (error) => Effect.succeed(error.reason)),
        Effect.provide(piThinker(configured))
      );

      expect(reason).toContain("agent.workspace");
      expect(reason).toContain(`agent.model "${model}"`);
      expect(reason).toContain("Register that model");
      expect(sent).toHaveLength(0);
    }),
  { arbitrary: { runs: 12 } }
);
