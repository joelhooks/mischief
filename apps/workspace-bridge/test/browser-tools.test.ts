import { expect, it } from "@effect/vitest";
import {
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schema,
} from "effect";
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
} from "effect/http";

import { FullProxy, fullProxyRoutes } from "../src/full-proxy.js";
import piCaptures from "./browser-tools-pi-captures.json" with { type: "json" };

const responses = "/v1/responses";

const messages = "/v1/messages?beta=true";

const model = "fixture-model";

const browser = "::ffff:172.30.213.7";

const full = "172.30.212.7";

const harness = Effect.gen(function* makeHarness() {
  const seen = yield* Ref.make<string[]>([]);
  const admissions = yield* Ref.make<string[]>([]);

  const upstream = HttpClient.make((request) => {
    if (!Predicate.isTagged(request.body, "Uint8Array")) {
      return Effect.die("Expected JSON request bytes");
    }

    const wire = new TextDecoder().decode(request.body.body);

    return Ref.update(seen, (items) => [...items, wire]).pipe(
      Effect.as(
        HttpClientResponse.fromWeb(request, new Response("provider response"))
      )
    );
  });

  const layer = fullProxyRoutes.pipe(
    Layer.provideMerge(
      FullProxy.layer({
        key: Redacted.make("fixture-key"),
        models: [model, ...piCaptures.map(({ body }) => body.model)],
        spend: (peer) =>
          Ref.update(admissions, (items) => [...items, peer]).pipe(
            Effect.as(undefined)
          ),
        upstream: "http://provider.test",
      })
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, upstream))
  );

  const connect = (peer: string) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(layer, {
          disableLogger: true,
          middleware: (app) =>
            app.pipe(
              Effect.updateService(
                HttpServerRequest.HttpServerRequest,
                (request) => request.modify({ peerAddress: Option.some(peer) })
              )
            ),
        })
      ),
      ({ dispose }) => Effect.promise(dispose)
    );

  return { admissions, connect, seen };
});

const send = (
  handler: (request: Request) => Promise<Response>,
  route: string,
  body: string
) =>
  Effect.promise(
    handler.bind(
      undefined,
      new Request(`http://bridge.test${route}`, {
        body,
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": full,
        },
        method: "POST",
      })
    )
  );

const refused = (
  route: string,
  body: Readonly<Record<string, Schema.Json>>,
  field: string,
  type: string
) => ({ body, field, route, type });

const assetUrl = "https://asset.invalid/fixture";

const messageBlock = (block: Schema.Json) => ({
  messages: [{ content: [block], role: "user" }],
});

const responseBlock = (block: Schema.Json) => ({
  input: [{ content: [block], role: "user" }],
});

const cases = [
  ...["image", "document"].map((type) =>
    refused(
      messages,
      messageBlock({ type, source: { type: "url", url: assetUrl } }),
      "messages[0].content[0].source.type",
      "url"
    )
  ),
  refused(
    responses,
    responseBlock({ type: "input_image", image_url: assetUrl }),
    "input[0].content[0].image_url",
    "string"
  ),
  refused(
    responses,
    responseBlock({ type: "input_image", file_id: "fixture-file" }),
    "input[0].content[0].file_id",
    "string"
  ),
  refused(
    responses,
    responseBlock({
      type: "input_image",
      image_url: "DATA:image/png;base64,eA==",
    }),
    "input[0].content[0].image_url",
    "string"
  ),
  refused(
    responses,
    responseBlock({ type: "input_image", image_url: "data:missing-comma" }),
    "input[0].content[0].image_url",
    "string"
  ),
  refused(
    responses,
    responseBlock({ type: "input_file", file_url: assetUrl }),
    "input[0].content[0].file_url",
    "string"
  ),
  refused(
    messages,
    messageBlock({ type: "image", source: { type: "Base64" } }),
    "messages[0].content[0].source.type",
    "Base64"
  ),
  refused(
    messages,
    messageBlock({
      type: "document",
      source: { type: "content", content: [] },
    }),
    "messages[0].content[0].source.type",
    "content"
  ),
  refused(
    messages,
    messageBlock({ type: "text", source: { type: "file" } }),
    "messages[0].content[0].source.type",
    "file"
  ),
  refused(
    messages,
    messageBlock({ type: "image", source: { type: "base64", url: assetUrl } }),
    "messages[0].content[0].source.url",
    "string"
  ),
  refused(
    responses,
    responseBlock({ type: "input_text", extra: { url: assetUrl } }),
    "input[0].content[0].extra.url",
    "string"
  ),
  ...[
    "web_search",
    "file_search",
    "mcp",
    "code_interpreter",
    "computer_use_preview",
    "foo",
    "Function",
    " function",
  ].map((type) =>
    refused(
      responses,
      { tools: [{ name: "read", type }] },
      "tools[0].type",
      type
    )
  ),
  refused(responses, { tools: [{ name: "read" }] }, "tools[0].type", "missing"),
  refused(responses, { tools: null }, "tools", "null"),
  ...[
    "web_search_20250305",
    "web_fetch_20250910",
    "code_execution_20250522",
    "bash_20250124",
    "foo",
  ].map((type) =>
    refused(
      messages,
      { tools: [{ name: "read", type }] },
      "tools[0].type",
      type
    )
  ),
  ...[responses, messages].map((route) =>
    refused(route, { mcp_servers: [] }, "mcp_servers", "array")
  ),
  refused(
    responses,
    { tool_choice: { type: "web_search" } },
    "tool_choice.type",
    "web_search"
  ),
  refused(
    responses,
    { tool_choice: "web_search" },
    "tool_choice",
    "web_search"
  ),
  refused(
    messages,
    { tool_choice: { type: "web_search_20250305" } },
    "tool_choice.type",
    "web_search_20250305"
  ),
  refused(
    responses,
    {
      tool_choice: { name: "other", type: "function" },
      tools: [{ name: "read", type: "function" }],
    },
    "tool_choice.name",
    "function"
  ),
  refused(
    messages,
    { tool_choice: { name: "other", type: "tool" }, tools: [{ name: "read" }] },
    "tool_choice.name",
    "tool"
  ),
  refused(responses, { prompt: { id: "fixture" } }, "prompt", "object"),
  refused(
    responses,
    { previous_response_id: "fixture" },
    "previous_response_id",
    "string"
  ),
  refused(responses, { conversation: "fixture" }, "conversation", "string"),
  refused(messages, { container: { skills: [] } }, "container", "object"),
  refused(responses, { background: false }, "background", "boolean"),
  refused(responses, { store: true }, "store", "boolean"),
  refused(responses, { store: "false" }, "store", "string"),
  refused(
    responses,
    { include: ["reasoning.encrypted_content", "file_search_call.results"] },
    "include",
    "array"
  ),
  refused(responses, { include: [] }, "include", "array"),
  refused(
    responses,
    {
      input: [
        { content: "test", role: "user", tools: [{ type: "web_search" }] },
      ],
    },
    "input[0].tools",
    "array"
  ),
  refused(
    responses,
    {
      input: [
        {
          tools: [{ name: "read", type: "function" }],
          type: "additional_tools",
        },
      ],
    },
    "input[0].tools",
    "array"
  ),
  refused(
    responses,
    { input: [{ type: "web_search_call" }] },
    "input[0].type",
    "web_search_call"
  ),
  refused(
    responses,
    { input: [{ id: "fixture", type: "item_reference" }] },
    "input[0].type",
    "item_reference"
  ),
  refused(
    responses,
    { input: [{ content: [{ type: "web_search" }], role: "user" }] },
    "input[0].content[0].type",
    "web_search"
  ),
  refused(
    messages,
    {
      messages: [
        {
          content: [{ tools: [{ type: "web_search_20250305" }], type: "text" }],
          role: "user",
        },
      ],
    },
    "messages[0].content[0].tools",
    "array"
  ),
  ...["server_tool_use", "web_search_tool_result", "future_tool_result"].map(
    (type) =>
      refused(
        messages,
        { messages: [{ content: [{ type }], role: "assistant" }] },
        "messages[0].content[0].type",
        type
      )
  ),
];

const RefusalJson = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.String,
      field: Schema.String,
      message: Schema.String,
      received: Schema.String,
    }),
  })
);

for (const { body, field, route, type } of cases) {
  it.effect(
    `refuses ${route} ${field} (${type}) only for browser peers before admission`,
    () =>
      Effect.gen(function* browserRefusal() {
        const { admissions, connect, seen } = yield* harness;
        const { handler } = yield* connect(browser);
        const wire = JSON.stringify({ model, ...body });
        const response = yield* send(handler, route, wire);
        expect(response.status).toBe(403);

        const { error } = yield* Schema.decodeEffect(RefusalJson)(
          yield* Effect.promise(response.text.bind(response))
        );

        expect(error.code).toBe("BrowserToolRefused");
        expect(error.field).toBe(field);
        expect(error.received).toBe(type);
        expect(error.message).toContain(
          "browser boxes accept only client-defined function tools"
        );
        expect(yield* Ref.get(admissions)).toEqual([]);
        expect(yield* Ref.get(seen)).toEqual([]);

        for (const peer of [full, "127.0.0.1"]) {
          const legacy = yield* connect(peer);
          const accepted = yield* send(legacy.handler, route, wire);
          expect(accepted.status).toBe(200);
          expect(yield* Effect.promise(accepted.text.bind(accepted))).toBe(
            "provider response"
          );
        }

        expect(yield* Ref.get(admissions)).toEqual([full, "127.0.0.1"]);
        expect(yield* Ref.get(seen)).toEqual([wire, wire]);
      }).pipe(Effect.scoped)
  );
}

it.effect(
  "forwards only client-defined tools and matching tool choices for browser peers without changing their bodies",
  () =>
    Effect.gen(function* allowedTools() {
      const { admissions, connect, seen } = yield* harness;
      const { handler } = yield* connect(browser);

      const allowed = [
        {
          route: responses,
          body: {
            tools: [{ name: "read", type: "function" }],
            tool_choice: { name: "read", type: "function" },
          },
        },
        {
          route: responses,
          body: {
            include: ["reasoning.encrypted_content"],
            store: false,
            tool_choice: { name: "edit", type: "custom" },
            tools: [{ name: "edit", type: "custom" }],
          },
        },
        {
          route: messages,
          body: {
            tools: [{ name: "read" }],
            tool_choice: { name: "read", type: "tool" },
          },
        },
        {
          route: messages,
          body: {
            tools: [{ name: "read", type: "custom" }],
            tool_choice: { type: "auto" },
          },
        },
        {
          route: messages,
          body: messageBlock({
            type: "document",
            source: { type: "text", media_type: "text/plain", data: assetUrl },
          }),
        },
        {
          route: messages,
          body: messageBlock({
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "eA==",
            },
          }),
        },
        {
          route: responses,
          body: {
            tools: [
              {
                type: "function",
                name: "visit",
                parameters: {
                  type: "object",
                  properties: { url: { type: "string" } },
                },
              },
            ],
          },
        },
      ];

      const wires = [];

      for (const { body, route } of allowed) {
        const wire = JSON.stringify({ model, ...body });
        wires.push(wire);
        const response = yield* send(handler, route, wire);
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(response.text.bind(response))).toBe(
          "provider response"
        );
      }

      expect(yield* Ref.get(admissions)).toEqual(allowed.map(() => browser));
      expect(yield* Ref.get(seen)).toEqual(wires);
    }).pipe(Effect.scoped)
);

for (const { body, image, route, version } of piCaptures) {
  it.effect(
    `forwards the pi-ai ${version} ${route} ${image === true ? "inline image" : "text"} capture with its client tool intact`,
    () =>
      Effect.gen(function* capturedPiRequest() {
        const { admissions, connect, seen } = yield* harness;
        const { handler } = yield* connect(browser);
        const wire = JSON.stringify(body);
        const response = yield* send(handler, route, wire);
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(response.text.bind(response))).toBe(
          "provider response"
        );
        expect(yield* Ref.get(admissions)).toEqual([browser]);
        expect(yield* Ref.get(seen)).toEqual([wire]);
      }).pipe(Effect.scoped)
  );
}

it.effect(
  "refuses a browser body larger than 8 MiB before parsing even without a declared length",
  () =>
    Effect.gen(function* oversizedBody() {
      const { admissions, connect, seen } = yield* harness;
      const { handler } = yield* connect(browser);

      const response = yield* send(
        handler,
        responses,
        JSON.stringify({
          input: "x".repeat(8 * 1024 * 1024),
          model,
          tools: [{ type: "web_search" }],
        })
      );

      expect(response.status).toBe(413);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      expect(yield* Effect.promise(response.text.bind(response))).toContain(
        "8 MiB"
      );
      expect(yield* Ref.get(admissions)).toEqual([]);
      expect(yield* Ref.get(seen)).toEqual([]);
    }).pipe(Effect.scoped)
);
