// @effect-diagnostics asyncFunction:off -- The fake box Durable Object's fetch handler is a Promise API.
import { DurableObject } from "cloudflare:workers";
import { Effect, Schema } from "effect";

const RequestBody = Schema.Struct({
  newPeonId: Schema.optionalKey(Schema.String),
  peonId: Schema.optionalKey(Schema.String),
  requestId: Schema.String,
  template: Schema.optionalKey(
    Schema.Struct({
      limits: Schema.Struct({
        cpus: Schema.Int,
        memory: Schema.String,
        pids: Schema.Int,
      }),
      model: Schema.String,
      system: Schema.optionalKey(Schema.String),
      thinking: Schema.String,
      tools: Schema.Literal("all"),
      warm: Schema.Struct({
        contract: Schema.optionalKey(Schema.String),
        docs: Schema.Array(
          Schema.Struct({ path: Schema.String, text: Schema.String })
        ),
      }),
      workspace: Schema.Struct({ repo: Schema.String, sha: Schema.String }),
    })
  ),
  text: Schema.optionalKey(Schema.String),
});

const Call = Schema.Struct({ path: Schema.String, requestId: Schema.String });

const Calls = Schema.Array(Call);

const Turn = {
  exit: 0,
  model: "opus",
  output: "I remember the file we wrote",
  thinking: "medium",
  toolCalls: ["edit", "bash"],
  usage: { cacheRead: 12, cacheWrite: 3, input: 20, output: 4, total: 39 },
  wallMs: 1,
};

export class FakeBox extends DurableObject {
  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;

    const calls = Schema.decodeUnknownSync(Calls)(
      (await this.ctx.storage.get("calls")) ?? []
    );

    if (path === "/__calls") {
      return Response.json(calls);
    }

    if (request.headers.get("authorization") !== "Bearer fake-box-key") {
      return Response.json(
        { error: { message: "Missing box key" } },
        { status: 401 }
      );
    }

    if (request.method === "GET") {
      return Response.json({
        bytes: { home: 20, snapshot: 30, work: 10 },
        container: "box",
        lastPromptAt: null,
        state: "idle",
      });
    }

    const text = await request.text();

    const body = await Effect.runPromise(
      Schema.decodeEffect(Schema.fromJsonString(RequestBody))(text, {
        onExcessProperty: "error",
      })
    );

    const key = `${path}/${body.requestId}`;
    const previous = await this.ctx.storage.get(key);
    await this.ctx.storage.put("calls", [
      ...calls,
      { path, requestId: body.requestId },
    ]);

    if (previous !== undefined) {
      return Response.json(previous);
    }

    let response: Schema.Json;

    if (path === "/v1/boxes") {
      response = {
        image: "example/box@sha256:012345",
        peonId: body.peonId ?? "",
        state: "idle",
        workspace: body.template?.workspace ?? {},
      };
    } else if (path.endsWith("/prompt")) {
      response = Turn;
    } else if (path.endsWith("/clone")) {
      response = { peonId: body.newPeonId ?? "", state: "suspended" };
    } else if (path.endsWith("/suspend")) {
      response = { state: "suspended" };
    } else if (path.endsWith("/hibernate")) {
      response = {
        snapshot: {
          bytes: 30,
          path: "/snapshots/fake.tar",
          sha256: "a".repeat(64),
        },
        state: "hibernated",
      };
    } else if (request.method === "DELETE") {
      response = { snapshotKept: true, state: "destroyed" };
    } else {
      response = { restored: true, state: "idle" };
    }

    await this.ctx.storage.put(key, response);

    if (path.endsWith("/prompt") && body.text === "hold-until-eviction") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        })
      );
    }

    return Response.json(response);
  }
}

export default {
  async fetch(
    request: Request,
    env: { readonly TEST_BOX: DurableObjectNamespace<FakeBox> }
  ) {
    return await env.TEST_BOX.getByName("box").fetch(request);
  },
};
