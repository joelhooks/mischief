// @effect-diagnostics asyncFunction:off -- The fake box Durable Object's fetch handler is a Promise API.
import { DurableObject } from "cloudflare:workers";
import { Effect, Schema } from "effect";

const RequestBody = Schema.Struct({
  discardWorkspace: Schema.optionalKey(Schema.Literal(true)),
  landedHead: Schema.optionalKey(Schema.String),
  newPeonId: Schema.optionalKey(Schema.String),
  peonId: Schema.optionalKey(Schema.String),
  requestId: Schema.String,
  template: Schema.optionalKey(
    Schema.Struct({
      limits: Schema.Struct({
        cpus: Schema.Int,
        memory: Schema.String,
        pids: Schema.Int,
        tmp: Schema.String,
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

const Call = Schema.Struct({
  path: Schema.String,
  requestId: Schema.String,
  discardWorkspace: Schema.optionalKey(Schema.Literal(true)),
  landedHead: Schema.optionalKey(Schema.String),
});

const Calls = Schema.Array(Call);

const exportReceipt = {
  id: "worker-a/archive",
  location: "/primary/archive/RECEIPT.json",
  mirror: "/replica/archive/RECEIPT.json",
  sha256: "a".repeat(64),
};

const Turn = {
  exit: 0,
  model: "opus",
  output: "I remember the file we wrote",
  thinking: "medium",
  toolCalls: ["edit", "bash"],
  usage: { cacheRead: 12, cacheWrite: 3, input: 20, output: 4, total: 39 },
  wallMs: 1,
};

type CallValue = typeof Call.Type;

type MutableCall = { -readonly [K in keyof CallValue]: CallValue[K] };

const callOf = (path: string, body: typeof RequestBody.Type) => {
  const call: MutableCall = { path, requestId: body.requestId };

  if (body.discardWorkspace !== undefined) {
    call.discardWorkspace = body.discardWorkspace;
  }

  if (body.landedHead !== undefined) {
    call.landedHead = body.landedHead;
  }

  return call;
};

const deleteRefusal = (body: typeof RequestBody.Type, exported: boolean) => {
  if ((body.landedHead === undefined) === (body.discardWorkspace !== true)) {
    return Response.json(
      { error: { code: "WorkspaceUnlanded" } },
      { status: 409 }
    );
  }

  return exported
    ? undefined
    : Response.json({ error: { code: "ReceiptMismatch" } }, { status: 409 });
};

const custodyMissing = {
  code: "CustodyMissing",
  message:
    "Protected archive is not configured. Configure both archive roots before exporting or destroying.",
};

const refusals = new Map([
  [
    "custody-incomplete",
    { code: "CustodyIncomplete", message: "Session files were skipped." },
  ],
  [
    "replica-pending",
    {
      code: "ReplicaPending",
      message: "The archive replica is still copying.",
    },
  ],
  [
    "replica-mismatch",
    {
      code: "ReplicaMismatch",
      message: "The replica checksum differs from the primary.",
    },
  ],
  [
    "workspace-unlanded",
    {
      code: "WorkspaceUnlanded",
      message: "The workspace has unlanded changes.",
      dirtyPaths: ["src/draft.ts"],
      refs: ["refs/heads/draft"],
    },
  ],
  [
    "destroy-in-progress",
    { code: "DestroyInProgress", message: "A destroy is already recorded." },
  ],
  [
    "receipt-mismatch",
    {
      code: "ReceiptMismatch",
      message: "The primary archive receipt did not match.",
    },
  ],
  ["generic-failure", { code: "Unavailable", message: "The box is offline." }],
]);

export class FakeBox extends DurableObject {
  private async deleteRefusal(path: string, body: typeof RequestBody.Type) {
    const denial = refusals.get(path.slice("/v1/boxes/".length));

    if (denial !== undefined && denial.code !== "ReceiptMismatch") {
      return Response.json({ error: denial }, { status: 409 });
    }

    const testMissing = `${path}/custody-missing-once`;

    if (
      path === "/v1/boxes/worker-a" &&
      (await this.ctx.storage.get<boolean>(testMissing)) !== true
    ) {
      await this.ctx.storage.put(testMissing, true);

      return Response.json({ error: custodyMissing }, { status: 503 });
    }

    if ((await this.ctx.storage.get<boolean>(`${path}/retained`)) === true) {
      return Response.json(
        { error: { code: "WorkspaceUnlanded" } },
        { status: 409 }
      );
    }

    const exported =
      (await this.ctx.storage.get<boolean>(`${path}/export`)) === true;

    return deleteRefusal(
      body,
      exported &&
        !(path === "/v1/boxes/worker-a" && body.discardWorkspace === true)
    );
  }

  private async exportBox(path: string, key: string) {
    const denial = refusals.get(
      path.slice("/v1/boxes/".length, -"/export".length)
    );

    if (denial?.code === "ReceiptMismatch") {
      return Response.json({ error: denial }, { status: 409 });
    }

    const response = {
      state: "suspended",
      exportReceipt: { ...exportReceipt, replicaState: "pending" },
    };

    await this.ctx.storage.put(path, true);
    await this.ctx.storage.put(key, response);

    return Response.json(response);
  }

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
    await this.ctx.storage.put("calls", [...calls, callOf(path, body)]);

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
      await this.ctx.storage.put(path.replace("/hibernate", "/retained"), true);
      response = {
        snapshot: {
          bytes: 30,
          path: "/snapshots/fake.tar",
          retained: true,
          sha256: "a".repeat(64),
        },
        state: "hibernated",
      };
    } else if (path.endsWith("/export")) {
      return await this.exportBox(path, key);
    } else if (request.method === "DELETE") {
      const denied = await this.deleteRefusal(path, body);

      if (denied !== undefined) {
        return denied;
      }

      response = {
        snapshotKept: false,
        state: "destroyed",
        exportReceipt: { ...exportReceipt, replicaState: "verified" },
      };
    } else {
      await this.ctx.storage.delete(path.replace("/resume", "/retained"));
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
