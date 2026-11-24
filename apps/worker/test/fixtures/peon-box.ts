// @effect-diagnostics asyncFunction:off -- The fake box Durable Object's fetch handler is a Promise API.
import { DurableObject } from "cloudflare:workers";
import { Deferred, Effect, Schema } from "effect";

const RequestBody = Schema.Struct({
  discardWorkspace: Schema.optionalKey(Schema.Literal(true)),
  landedHead: Schema.optionalKey(Schema.String),
  newPeonId: Schema.optionalKey(Schema.String),
  peonId: Schema.optionalKey(Schema.String),
  requestId: Schema.String,
  template: Schema.optionalKey(
    Schema.Struct({
      browser: Schema.optionalKey(
        Schema.Struct({ hosts: Schema.Array(Schema.String) })
      ),
      imageKey: Schema.optionalKey(Schema.Literal("browser")),
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

const fixtureTurn = (path: string) =>
  path === "/v1/boxes/tail-owner/prompt"
    ? {
        ...Turn,
        output:
          "I remember the file we wrote. Bearer fake-last-turn-key\u001B]52;c;private-clipboard\u0007",
        toolCalls: ["edit\u001B[31m", "bash"],
      }
    : Turn;

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

const failedPrompt = () =>
  Response.json(
    {
      error: {
        code: "PromptFailed",
        message: "The provider is unavailable.",
        state: "suspended",
      },
    },
    { status: 503 }
  );

const staleResume = () =>
  Response.json(
    {
      error: {
        code: "BoxNetworkStale",
        message:
          "A browser box must be attached only to the browser network. Recreate or destroy this browser box before retrying.",
      },
    },
    { status: 409 }
  );

const resumeRefusal = (path: string) => {
  if (path === "/v1/boxes/stale-browser/resume") {
    return staleResume();
  }

  if (path === "/v1/boxes/unavailable-resume/resume") {
    return Response.json(
      { error: { code: "BoxCapacity", message: "Manager unavailable." } },
      { status: 503 }
    );
  }

  return null;
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
      message: `The workspace has unlanded changes. ${"x".repeat(1000)} message-tail`,
      dirtyPaths: [
        "src/draft.ts",
        ...Array.from({ length: 999 }, (_, index) => `p${index}`),
      ],
      refs: [
        "refs/heads/draft",
        ...Array.from({ length: 20 }, (_, index) => `r${index}`),
      ],
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
  private readonly releaseStoppedInspect = Deferred.makeUnsafe<undefined>();
  private readonly releaseStaleResume = Deferred.makeUnsafe<undefined>();
  private stoppedInspects = 0;

  private async writeLifecycleState(path: string) {
    if (path.endsWith("/suspend") || path.endsWith("/resume")) {
      const key = path.replace(/\/(?:suspend|resume)$/u, "/state");
      await this.ctx.storage.put(
        key,
        path.endsWith("/suspend") ? "suspended" : "idle"
      );
    }
  }

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

  private async read(
    path: string,
    method: string,
    calls: readonly CallValue[]
  ) {
    if (method === "GET") {
      const state = (await this.ctx.storage.get(`${path}/state`)) ?? "idle";

      if (path === "/v1/boxes/alarm-stale-browser") {
        await this.ctx.storage.put("calls", [
          ...calls,
          { path, requestId: "inspect" },
        ]);
      }

      if (path === "/v1/boxes/stuck-suspend" && state === "suspended") {
        this.stoppedInspects += 1;

        if (this.stoppedInspects === 1) {
          return Response.json(
            { error: { message: "Host du exited 1" } },
            { status: 400 }
          );
        }

        if (this.stoppedInspects === 2) {
          await this.ctx.storage.put("calls", [
            ...calls,
            { path, requestId: "held-inspect" },
          ]);
          await Effect.runPromise(Deferred.await(this.releaseStoppedInspect));
        }

        return Response.json({
          bytes: null,
          container: "box",
          lastPromptAt: null,
          processes: 0,
          state,
        });
      }

      return Response.json({
        bytes: { home: 20, snapshot: 30, work: 10 },
        container: "box",
        lastPromptAt: null,
        state,
      });
    }

    if (method === "POST" && path.endsWith("/tail")) {
      await this.ctx.storage.put("calls", [
        ...calls,
        { path, requestId: "tail-read" },
      ]);

      return Response.json({
        entries: [{ bytes: 50, id: "b51", type: "assistant" }],
        status: "tail",
        truncated: false,
      });
    }

    return null;
  }

  private async promptBox(path: string, key: string, text: string | undefined) {
    const previous = await this.ctx.storage.get(key);

    if (previous !== undefined) {
      return previous === "failed-prompt"
        ? failedPrompt()
        : Response.json(previous);
    }

    const stateKey = path.replace(/\/prompt$/u, "/state");

    if (text === "fail-this-turn") {
      await this.ctx.storage.put(key, "failed-prompt");
      await this.ctx.storage.put(stateKey, "suspended");

      return failedPrompt();
    }

    const response = fixtureTurn(path);
    await this.ctx.storage.put(key, response);
    await this.ctx.storage.delete(stateKey);

    return text === "hold-until-eviction"
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
          })
        )
      : Response.json(response);
  }

  private async resumeDenial(path: string, calls: readonly CallValue[]) {
    if (path !== "/v1/boxes/alarm-stale-browser/resume") {
      return resumeRefusal(path);
    }

    if (!calls.some((call) => call.path === path)) {
      return Response.json(
        { error: "Temporarily unavailable" },
        { status: 503 }
      );
    }

    await Effect.runPromise(Deferred.await(this.releaseStaleResume));

    return staleResume();
  }

  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;

    const calls = Schema.decodeUnknownSync(Calls)(
      (await this.ctx.storage.get("calls")) ?? []
    );

    if (path === "/__calls") {
      return Response.json(calls);
    }

    const releases = new Map([
      ["/__release-stopped-inspect", this.releaseStoppedInspect],
      ["/__release-stale-resume", this.releaseStaleResume],
    ]);

    const release = releases.get(path);

    if (release !== undefined) {
      await Effect.runPromise(Deferred.succeed(release, undefined));

      return new Response(null, { status: 204 });
    }

    if (request.headers.get("authorization") !== "Bearer fake-box-key") {
      return Response.json(
        { error: { message: "Missing box key" } },
        { status: 401 }
      );
    }

    const read = await this.read(path, request.method, calls);

    if (read !== null) {
      return read;
    }

    const text = await request.text();

    const body = await Effect.runPromise(
      Schema.decodeEffect(Schema.fromJsonString(RequestBody))(text, {
        onExcessProperty: "error",
      })
    );

    const key = `${path}/${body.requestId}`;
    await this.ctx.storage.put("calls", [...calls, callOf(path, body)]);

    if (path.endsWith("/prompt")) {
      return await this.promptBox(path, key, body.text);
    }

    const resumeDenied = await this.resumeDenial(path, calls);

    if (resumeDenied !== null) {
      return resumeDenied;
    }

    const previous = await this.ctx.storage.get(key);

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

    await this.writeLifecycleState(path);
    await this.ctx.storage.put(key, response);

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
